import { Observable, Subject } from 'rxjs';
import { packetForType, packetType } from './packet-type-registry';
import { MessageType } from '@protobuf-ts/runtime';
import { PacketType } from './packet-type';
import { ITransport } from './transport';

interface MumbleSocketReader {
  length: number;
  callback: (data: Buffer) => void;
}

interface AudioPacket {
  source: number; // Session ID of the source user
  data: Buffer;
  sequence: number;
  frameNumber: bigint;
  isTerminator: boolean;
}

export class MumbleSocket {
  private readonly _packet = new Subject<PacketType>();
  // Kept as a public observable so consumers compile; the native UDP voice
  // path retired in media-plane phase 2 / phase 1 step 3, so no events ever
  // fire here from this socket. WebRTC voice flows through
  // `RTCPeerConnection` directly, not through the Mumble control channel.
  private readonly _audioPacket = new Subject<AudioPacket>();
  private buffers: Buffer[] = [];
  private length = 0;
  private readers: MumbleSocketReader[] = [];

  constructor(private readonly transport: ITransport) {
    this.transport.onData.subscribe((data: Buffer) => {
      this.receiveData(data);
    });
    this.readPrefix();
  }

  get packet(): Observable<PacketType> {
    return this._packet.asObservable();
  }

  get audioPacket(): Observable<AudioPacket> {
    return this._audioPacket.asObservable();
  }

  read(length: number, callback: MumbleSocketReader['callback']): void {
    this.readers.push({ length, callback });
    if (this.readers.length === 1) {
      this.flushReaders();
    }
  }

  async send<T extends object>(
    message: MessageType<T>,
    payload: T,
  ): Promise<void> {
    const typeNumber = packetType(message);
    console.log(`Sending message type: ${message.typeName} (${typeNumber})`);
    if (typeNumber === undefined) {
      throw new Error(`unknown message type (${message.typeName})`);
    }

    const encoded = message.toBinary(payload);
    const prefix = Buffer.alloc(6);
    prefix.writeUint16BE(typeNumber, 0);
    prefix.writeUint32BE(encoded.length, 2);
    await this.write(Buffer.concat([prefix, encoded]));
  }

  write(buffer: Buffer | Uint8Array): Promise<void> {
    return this.transport.write(
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer),
    );
  }

  end() {
    this.transport.close();
  }

  private receiveData(data: Buffer) {
    this.buffers.push(data);
    this.length += data.length;
    this.flushReaders();
  }

  private flushReaders() {
    if (this.readers.length === 0) {
      return;
    }

    const reader = this.readers[0]!;
    if (this.length < reader.length) {
      return;
    }

    const buffer = Buffer.alloc(reader.length);
    let written = 0;

    while (written < reader.length) {
      const received = this.buffers[0]!;
      const remaining = reader.length - written;
      if (received.length <= remaining) {
        received.copy(buffer, written);
        written += received.length;
        this.buffers.splice(0, 1);
        this.length -= received.length;
      } else {
        received.copy(buffer, written, 0, remaining);
        written += remaining;
        this.buffers[0] = received.subarray(remaining);
        this.length -= remaining;
      }
    }

    this.readers.splice(0, 1);
    reader.callback(buffer);
  }

  private readPrefix() {
    this.read(6, prefix => {
      const type = prefix.readUint16BE(0);
      const length = prefix.readUint32BE(2);
      this.readPacket(type, length);
    });
  }

  private readPacket(type: number, length: number) {
    this.read(length, data => {
      const message = packetForType(type);
      if (message) {
        this._packet.next({
          type,
          typeName: message.typeName,
          payload: message.fromBinary(data),
        });
      } else {
        // Burned IDs (1 UDPTunnel / 15 CryptSetup / 19 VoiceTarget) and any
        // future unknown packet type land here. The server side refuses
        // them; on the client the safe thing is to drop and log.
        console.error(`Unrecognized packet type (${type})`);
      }

      this.readPrefix();
    });
  }
}
