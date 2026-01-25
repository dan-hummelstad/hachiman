export interface TextMessageState {
  message: string;
  fromUserId: number | undefined;
  channelIds: number[];
}