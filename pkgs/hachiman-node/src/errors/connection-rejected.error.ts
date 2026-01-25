import { Reject } from '../mumbleproto';

export class ConnectionRejectedError extends Error {
  constructor(public readonly reject: Reject) {
    super(reject.reason);
  }
}
