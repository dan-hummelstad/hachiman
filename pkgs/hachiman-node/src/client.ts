// tls-connect / tls-transport are dynamic-imported inside connect() so the
// browser bundle never pulls in Node's `tls` module (which would emit a
// `require()` the browser can't resolve). See connect() below.
import { WsTransport } from './ws-transport';
import { MumbleSocket } from './mumble-socket';
import {
  concatMap,
  debounceTime,
  exhaustMap,
  filter,
  groupBy,
  interval,
  lastValueFrom,
  map,
  race,
  switchMap,
  take,
  tap,
  throwError,
  timeout,
  zip,
} from 'rxjs';
import {
  Authenticate,
  ChannelMessageHistory,
  PermissionDenied,
  PermissionQuery,
  PersistedMessage,
  Ping,
  Reject,
  RelayMetricsQuery,
  RelayMetricsSnapshot,
  RequestChannelMessages,
  ServerConfig,
  ServerSync,
  TalkingState,
  TextMessage,
  UserList,
  UserList_User,
  UserRemove,
  UserState,
  Version,
  WebRTC,
} from './mumbleproto';
import { User } from './user';
import { ChannelManager } from './channel-manager';
import { UserManager } from './user-manager';
import { encodeMumbleVersion } from './encode-mumble-version';
import { ClientOptions } from './client-options';
import {
  ClientDisconnectedError,
  CommandTimedOutError,
  ConnectionRejectedError,
  PermissionDeniedError,
} from './errors';
import { filterPacket } from './rxjs-operators/filter-packet';
import { Permissions } from './permissions';
import { encodeMumbleVersionLegacy } from './encode-mumble-version-legacy';
import { TypedEventEmitter } from './typed-event-emitter';
import { Events } from './events';
import { ConnectionQualitySample } from './connection-quality-sample';
import { MessageType } from '@protobuf-ts/runtime';
import { CommandTimeout } from './config';
import { WebRTCVoice } from './webrtc-voice';

type PacketTuple<T extends object> = [MessageType<T>, T];
type ManyPackets<T extends object[]> = { [K in keyof T]: PacketTuple<T[K]> };

type CommandProps<
  Send extends object,
  Return extends object,
  SendMore extends object[] = [],
> = { expectPacket: [MessageType<Return>, (packet: Return) => boolean] } & (
  | {
      sendPacket: PacketTuple<Send>;
    }
  | {
      sendPackets: ManyPackets<[Send, ...SendMore]>;
    }
);

const defaultOptions: Partial<ClientOptions> = {
  port: 64738,
  clientName: 'hachiman-client',
  pingInterval: 10000,
};

interface ConnectedClient extends Client {
  socket: MumbleSocket;
  session: number;
  user: User;
  self: User;
}

export class Client extends TypedEventEmitter<Events, Events> {
  channels: ChannelManager = new ChannelManager(this);
  users: UserManager = new UserManager(this);
  serverVersion?: Version;
  serverConfig?: ServerConfig;
  socket?: MumbleSocket;
  session?: number;
  welcomeText?: string;
  webrtcVoice?: WebRTCVoice;
  private _pendingWebRTCOffer?: string;
  // Monotonically increasing identifier used to disambiguate concurrent
  // fetchChannelMessages() calls. The server echoes the value back in
  // ChannelMessageHistory.requestId.
  private _nextChannelHistoryRequestId = 1;
  readonly options: ClientOptions;

  // Channel permission cache
  readonly permissions = new Map<number, Permissions>();

  constructor(options: ClientOptions) {
    super();
    this.options = { ...defaultOptions, ...options };
  }

  /**
   * The currently logged-in user.
   * @deprecated Use Client.self
   */
  get user() {
    return this.self;
  }

  /**
   * The currently logged-in user.
   */
  get self() {
    if (!this.session) {
      return undefined;
    }

    return this.users.bySession(this.session);
  }

  /**
   * @returns true if the client is connected; false otherwise.
   */
  isConnected(): this is ConnectedClient {
    return !!this.socket;
  }

  /**
   * @throws ClientDisconnectedError if the client is not connected.
   */
  assertConnected(): asserts this is ConnectedClient {
    if (!this.socket) {
      throw new ClientDisconnectedError();
    }
  }

  /**
   * Establishes a connection to the provided Mumble server.
   */
  async connect(): Promise<this> {
    if (this.options.transport === 'websocket') {
      const wsUrl =
        this.options.wsUrl ?? `ws://${this.options.host}:${this.options.port}/`;
      const ws = new WsTransport(wsUrl);
      await ws.waitForOpen();
      this.socket = new MumbleSocket(ws);
    } else {
      // Dynamic import keeps Node's `tls` out of browser bundles — Vite
      // tree-shakes this branch when the host app only uses 'websocket'.
      const [{ tlsConnect }, { TlsTransport }] = await Promise.all([
        import('./tls-connect'),
        import('./tls-transport'),
      ]);
      const tlsSocket = await tlsConnect(this.options.host, this.options.port, {
        cert: this.options.cert,
        key: this.options.key,
        rejectUnauthorized: this.options.rejectUnauthorized,
      });
      this.socket = new MumbleSocket(new TlsTransport(tlsSocket));
    }

    this.socket.audioPacket
      .pipe(groupBy(packet => packet.source))
      .subscribe(group => {
        const user = this.users.bySession(group.key);
        if (!user) {
          console.warn(`unknown session: ${group.key}`);
          return;
        }

        let speaking = false;

        group.pipe(filter(() => !speaking)).subscribe(() => {
          speaking = true;
          this.emit('speakingStateChange', { user, speaking });
        });

        // if no packet comes for 40 milliseconds, the user stopped talking
        group.pipe(debounceTime(40)).subscribe(() => {
          speaking = false;
          this.emit('speakingStateChange', { user, speaking });
        });
      });
    this.socket.packet
      .pipe(filterPacket(TextMessage))
      .subscribe(textMessage => {
        this.emit('textMessage', {
          message: textMessage.message,
          fromUserId: textMessage.actor,
          channelIds: textMessage.channelId,
        });
      });
    this.emit('socketConnect', this.socket);

    this.socket.packet
      .pipe(
        filterPacket(PermissionQuery),
        filter(permissionQuery => permissionQuery.channelId !== undefined),
        map(permissionQuery => ({
          channelId: permissionQuery.channelId!,
          permissions: new Permissions(permissionQuery.permissions ?? 0),
        })),
      )
      .subscribe(({ channelId, permissions }) => {
        this.permissions.set(channelId, permissions);
      });

    this.socket.packet
      .pipe(
        filterPacket(UserRemove),
        filter(userRemove => userRemove.session === this.session),
      )
      .subscribe(userRemove => {
        this.emit('disconnect', {
          reason: userRemove.reason ?? 'unknown reason',
        });
        delete this.socket;
      });

    // Subscribe to WebRTC messages EARLY — the server sends the initial
    // offer before ServerSync, so we must be listening before the zip() wait.
    if (this.options.webrtc) {
      const webrtcSub = this.socket.packet
        .pipe(filterPacket(WebRTC))
        .subscribe(msg => {
          void (async () => {
            if (msg.sdpType === 'offer' && msg.sdp) {
              if (this.webrtcVoice) {
                await this.webrtcVoice.handleServerOffer(msg.sdp);
              } else {
                this._pendingWebRTCOffer = msg.sdp;
              }
            } else if (
              msg.sdpType === 'answer' &&
              msg.sdp &&
              this.webrtcVoice
            ) {
              await this.webrtcVoice.handleServerAnswer(msg.sdp);
            }
          })();
        });
      this.on('disconnect', () => {
        webrtcSub.unsubscribe();
      });
    }

    const initialize: Promise<this> = lastValueFrom(
      race(
        zip(
          this.socket.packet.pipe(filterPacket(ServerSync), take(1)),
          this.socket.packet.pipe(filterPacket(ServerConfig), take(1)),
          this.socket.packet.pipe(filterPacket(Version), take(1)),
        ).pipe(
          tap(([serverSync, serverConfig, version]) => {
            if (serverSync.session) {
              this.session = serverSync.session;
            }
            this.welcomeText = serverSync.welcomeText ?? '';
            this.serverVersion = version;
            this.serverConfig = serverConfig;
            this.emit('connect');
            this.startPinger();
            this.setupConnectionQuality();
            this.setupWebRTC();
            this.setupTalkingState();
          }),
          map(() => this),
        ),
        this.socket.packet.pipe(
          filterPacket(Reject),
          switchMap(reject =>
            throwError(() => new ConnectionRejectedError(reject)),
          ),
        ),
      ),
    );

    await this.sendVersion();
    await this.authenticate();
    await this.ping();
    return await initialize;
  }

  /**
   * Disconnects from the server.
   */
  disconnect(): this {
    this.webrtcVoice?.close();
    delete this.webrtcVoice;
    this.emit('disconnect');
    this.socket?.end();
    delete this.socket;
    return this;
  }

  /**
   * Wraps sending and receiving a packet in a convenient method.
   * Handles denied permissions response as well as command timeout.
   */
  async command<
    Send extends object,
    Return extends object,
    SendMore extends object[] = [],
  >(name: string, props: CommandProps<Send, Return, SendMore>) {
    this.assertConnected();
    const ret = lastValueFrom(
      race(
        this.socket.packet.pipe(
          filterPacket(props.expectPacket[0]),
          filter(props.expectPacket[1]),
          take(1),
          timeout({
            first: CommandTimeout,
            with: () => throwError(() => new CommandTimedOutError(name)),
          }),
        ),
        this.socket.packet.pipe(
          filterPacket(PermissionDenied),
          filter(pd => pd.session === this.session),
          take(1),
          concatMap(pd => throwError(() => new PermissionDeniedError(pd))),
        ),
      ),
    );

    if ('sendPackets' in props) {
      for (const [type, payload] of props.sendPackets) {
        await this.socket.send(type, payload);
      }
    } else {
      await this.socket.send(props.sendPacket[0], props.sendPacket[1]);
    }
    return ret;
  }

  /**
   * Fetch the list of users registered with the server.
   */
  async fetchRegisteredUsers(): Promise<UserList_User[]> {
    const ret = await this.command('fetchRegisteredUsers', {
      sendPacket: [UserList, UserList.create()],
      expectPacket: [UserList, () => true],
    });
    return ret.users;
  }

  /**
   * Deregisters the user; the user does not have to be online.
   */
  async deregisterUser(userId: number): Promise<void> {
    await this.command('deregisterUser', {
      sendPackets: [
        [UserList, UserList.create({ users: [{ userId }] })],
        [UserList, UserList.create()],
      ],
      expectPacket: [UserList, () => true],
    });
  }

  /**
   * Rename registered user; the user does not have to be online.
   */
  async renameRegisteredUser(userId: number, name: string): Promise<void> {
    await this.command('renameRegisteredUser', {
      sendPackets: [
        [UserList, UserList.create({ users: [{ userId, name }] })],
        // we need to send another packet, so we can wait on the expected UserList packet
        // we cannot just listen for a UserState packet, as the user we are renaming
        // may be offline
        // unfortunately, this re-sends the entire list
        [UserList, UserList.create()],
      ],
      expectPacket: [UserList, () => true],
    });
  }

  /**
   * Fetch a paginated page of persisted chat history for a single channel.
   *
   * Messages are returned newest-first. To page backwards, pass the smallest
   * `id` from the previous page as `beforeId`.
   *
   * Concurrent calls are disambiguated by a monotonically-increasing
   * `requestId` that the server echoes back in its response — each call
   * only resolves for the matching response.
   *
   * @param opts.channelId - Channel to fetch history for.
   * @param opts.beforeId - Cursor; only messages with id < beforeId are returned.
   *                       Omit (or pass 0n) to fetch the latest page.
   * @param opts.limit - Page size. Server default is 30, capped at 100.
   */
  async fetchChannelMessages(opts: {
    channelId: number;
    beforeId?: bigint;
    limit?: number;
  }): Promise<{ messages: PersistedMessage[]; hasMore: boolean }> {
    const requestId = this._nextChannelHistoryRequestId++;
    const payload = RequestChannelMessages.create({
      channelId: opts.channelId,
      beforeId: opts.beforeId ?? 0n,
      requestId,
    });
    if (opts.limit !== undefined) {
      payload.limit = opts.limit;
    }
    const ret = await this.command('fetchChannelMessages', {
      sendPacket: [RequestChannelMessages, payload],
      expectPacket: [
        ChannelMessageHistory,
        packet =>
          packet.requestId === requestId && packet.channelId === opts.channelId,
      ],
    });
    return {
      messages: ret.messages,
      hasMore: ret.hasMore ?? false,
    };
  }

  /**
   * Fetch the server relay's thin/on-path voice metrics snapshot.
   *
   * Sends an (empty) {@link RelayMetricsQuery} over the control channel and
   * resolves with the {@link RelayMetricsSnapshot} reply. Mirrors how
   * {@link Channel.fetchAcl} issues a request/reply over the control channel.
   *
   * The server gates this on operator privilege (SuperUser or Write on the
   * root channel) and responds with a PermissionDenied to anyone else — which
   * {@link Client.command} surfaces as a rejected promise
   * ({@link PermissionDeniedError}). A `RelayMetricsSnapshot` is only ever sent
   * in reply to a query, so the reply needs no correlation id.
   */
  async fetchRelayMetrics(): Promise<RelayMetricsSnapshot> {
    const snapshot = await this.command('fetchRelayMetrics', {
      sendPacket: [RelayMetricsQuery, RelayMetricsQuery.create()],
      expectPacket: [RelayMetricsSnapshot, () => true],
    });
    return snapshot;
  }

  /**
   * @internal
   */
  private async sendVersion(): Promise<void> {
    const version = {
      major: 1,
      minor: 4,
      patch: 287,
    };

    // Detect browser vs Node.js environment
    const isBrowser = typeof globalThis.navigator !== 'undefined';
    let osName = 'Unknown';
    let osVersion = 'Unknown';

    if (isBrowser) {
      osName = 'Web';
      osVersion = globalThis.navigator.userAgent;
    } else {
      try {
        const os = await import('os');
        osName = os.platform();
        osVersion = os.release();
      } catch {
        // os module not available (browser build)
      }
    }

    return await this.socket?.send(
      Version,
      Version.create({
        release: this.options.clientName ?? '',
        versionV1: encodeMumbleVersionLegacy(version),
        versionV2: encodeMumbleVersion(version),
        os: osName,
        osVersion,
      }),
    );
  }

  /**
   * @internal
   */
  private async authenticate(): Promise<void> {
    return await this.socket?.send(
      Authenticate,
      Authenticate.create({
        username: this.options.username,
        ...(this.options.password ? { password: this.options.password } : {}),
        tokens: this.options.tokens ?? [],
        opus: true,
        webrtc: this.options.webrtc ?? false,
        ...(this.options.oracleToken
          ? { oracleToken: this.options.oracleToken }
          : {}),
      }),
    );
  }

  /**
   * @internal
   *
   * Sends a Ping stamped with the current wall-clock time (ms since epoch) in
   * the `timestamp` field. The server echoes this value back verbatim (see the
   * Go `handlePingMessage`), so `setupConnectionQuality()` recovers the
   * round-trip time as `Date.now() - echo.timestamp`. Mumble's `timestamp` is
   * an opaque uint64 the server must not decode, so using ms-since-epoch here
   * is safe and makes the echo delta directly an RTT in milliseconds.
   */
  private async ping() {
    return await this.socket?.send(
      Ping,
      Ping.create({ timestamp: BigInt(Date.now()) }),
    );
  }

  /**
   * @internal
   */
  private startPinger() {
    const subscription = interval(this.options.pingInterval)
      .pipe(exhaustMap(() => this.ping()))
      .subscribe();
    this.on('disconnect', () => {
      subscription.unsubscribe();
    });
  }

  /**
   * @internal
   *
   * Subscribes to inbound Ping responses and emits a `connectionQuality`
   * sample for each one. Each Ping doubles as the poll tick for WebRTC voice
   * stats. Derivations (no fabricated values — anything that can't be computed
   * from the data seen so far is left `null`):
   *
   *  - **RTT**: `Date.now() - echo.timestamp` from the control-channel Ping.
   *    The server echoes the client's Ping `timestamp` verbatim (which
   *    `ping()` stamps with ms-since-epoch), so the delta is the round-trip
   *    time in ms. This works before any voice flows. When WebRTC voice
   *    reports a `roundTripTime` it is preferred (it measures the actual voice
   *    path); otherwise the Ping RTT is used. Echoes missing a usable
   *    timestamp yield `null` (unless a WebRTC RTT is available).
   *  - **Jitter**: taken from the WebRTC inbound audio RTP report when voice
   *    is flowing (the real voice-path jitter). Before that — or in the
   *    non-WebRTC case — it falls back to the mean absolute deviation of the
   *    last `RTT_WINDOW` control-channel RTT samples (`null` until two exist).
   *  - **Packet loss**: derived from the WebRTC inbound audio RTP report's
   *    cumulative `packetsLost`/`packetsReceived`, differenced against the
   *    previous sample so the figure reflects the most recent interval:
   *    `Δlost / (Δlost + Δreceived)`. `null` until two samples exist, when the
   *    interval saw no packets (denominator 0), or in the non-WebRTC case
   *    (the native-UDP voice path was deleted in media-plane phase 1
   *    step 3; the legacy server-side OCB good/late/lost counters that
   *    sat behind `pkg/cryptstate/` went with it, so the non-WebRTC fallback
   *    has no packet-loss source at all). Counter resets on track/reconnect
   *    are floored to 0.
   *  - **Transport**: `'webrtc'` when WebRTC voice was requested, else `null`
   *    (this client has no native-UDP voice path to label otherwise).
   */
  private setupConnectionQuality() {
    if (!this.socket) return;

    const RTT_WINDOW = 10;
    const rttSamples: number[] = [];

    // Previous cumulative WebRTC voice packet counters, for interval-differencing.
    let prevVoiceCounters:
      | { packetsLost: number; packetsReceived: number }
      | undefined;

    const transport: ConnectionQualitySample['transport'] = this.options.webrtc
      ? 'webrtc'
      : null;

    // True while a WebRTC stats poll is in flight, so overlapping pings don't
    // stack concurrent getStats() calls or race the counter diff.
    let polling = false;

    const sub = this.socket.packet.pipe(filterPacket(Ping)).subscribe(ping => {
      const now = Date.now();

      // RTT from the echoed timestamp. Guard against missing/zero/future
      // timestamps (e.g. an unstamped legacy Ping) — those aren't RTTs.
      let pingRttMs: number | null = null;
      if (ping.timestamp !== undefined && ping.timestamp > 0n) {
        const delta = now - Number(ping.timestamp);
        if (Number.isFinite(delta) && delta >= 0) {
          pingRttMs = delta;
          rttSamples.push(delta);
          if (rttSamples.length > RTT_WINDOW) rttSamples.shift();
        }
      }

      // Jitter as mean absolute deviation of recent RTTs (needs >= 2). Used as
      // the fallback when WebRTC voice jitter isn't available yet.
      let rttMadJitterMs: number | null = null;
      if (rttSamples.length >= 2) {
        const mean = rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length;
        rttMadJitterMs =
          rttSamples.reduce((a, b) => a + Math.abs(b - mean), 0) /
          rttSamples.length;
      }

      // Non-WebRTC path: no voice transport to measure loss/jitter from, so
      // emit RTT only and leave the voice-path metrics null (honest).
      if (!this.options.webrtc || !this.webrtcVoice) {
        this.emit('connectionQuality', {
          rttMs: pingRttMs,
          jitterMs: rttMadJitterMs,
          packetLoss: null,
          transport,
          sampledAt: now,
        });
        return;
      }

      // WebRTC path: fold in voice-path stats from RTCStats. getStats() is
      // async; if a previous poll is still running, emit the Ping-only sample
      // now rather than queueing.
      if (polling) {
        this.emit('connectionQuality', {
          rttMs: pingRttMs,
          jitterMs: rttMadJitterMs,
          packetLoss: null,
          transport,
          sampledAt: now,
        });
        return;
      }

      polling = true;
      const webrtcVoice = this.webrtcVoice;
      void webrtcVoice
        .getQualityStats()
        .then(stats => {
          // Packet loss from the delta of cumulative WebRTC packet counters.
          let packetLoss: number | null = null;
          if (stats.packetsLost !== null && stats.packetsReceived !== null) {
            if (prevVoiceCounters) {
              const dLost = Math.max(
                0,
                stats.packetsLost - prevVoiceCounters.packetsLost,
              );
              const dRecv = Math.max(
                0,
                stats.packetsReceived - prevVoiceCounters.packetsReceived,
              );
              const total = dLost + dRecv;
              if (total > 0) {
                packetLoss = dLost / total;
              }
            }
            prevVoiceCounters = {
              packetsLost: stats.packetsLost,
              packetsReceived: stats.packetsReceived,
            };
          }

          // Prefer WebRTC voice-path jitter/RTT; fall back to Ping-derived.
          // (`?? fallback` keeps a real 0 and only substitutes on null.)
          const jitterMs = stats.jitterMs ?? rttMadJitterMs;
          const rttMs = stats.rttMs ?? pingRttMs;

          this.emit('connectionQuality', {
            rttMs,
            jitterMs,
            packetLoss,
            transport,
            sampledAt: now,
          });
        })
        .finally(() => {
          polling = false;
        });
    });

    this.on('disconnect', () => {
      sub.unsubscribe();
    });
  }

  /**
   * @internal
   * Sets up WebRTC voice transport if the client requested it.
   */
  private setupWebRTC() {
    if (!this.options.webrtc || !this.socket || !this.session) return;

    this.webrtcVoice = new WebRTCVoice(this.socket, this.session);

    // Process any offer that arrived before WebRTCVoice was created
    // (the server sends the initial offer before ServerSync)
    if (this._pendingWebRTCOffer) {
      const offer = this._pendingWebRTCOffer;
      delete this._pendingWebRTCOffer;
      void this.webrtcVoice.handleServerOffer(offer);
    }

    // Track SSRC from UserState updates and register with WebRTCVoice
    const userStateSub = this.socket.packet
      .pipe(
        filterPacket(UserState),
        filter(us => us.ssrc !== undefined && us.session !== undefined),
      )
      .subscribe(us => {
        this.webrtcVoice?.registerSSRC(us.session!, us.ssrc!);
      });

    this.on('disconnect', () => {
      userStateSub.unsubscribe();
    });
  }

  /**
   * @internal
   * Subscribes to TalkingState messages for WebRTC speaking state detection.
   */
  private setupTalkingState() {
    if (!this.options.webrtc || !this.socket) return;

    const sub = this.socket.packet
      .pipe(filterPacket(TalkingState))
      .subscribe(msg => {
        const session = msg.session ?? 0;
        const user = this.users.bySession(session);
        if (!user) return;

        this.emit('speakingStateChange', {
          user,
          speaking: (msg.target ?? 0) > 0,
        });
      });

    this.on('disconnect', () => {
      sub.unsubscribe();
    });
  }
}
