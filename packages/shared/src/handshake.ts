export interface HelloMessage {
  type: "lcode-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

export interface HelloAckMessage {
  type: "lcode-hello-ack";
  version: string;
  clientId: string;
}
