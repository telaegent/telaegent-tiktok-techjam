declare module "@napi-rs/keyring" {
  export class AsyncEntry {
    constructor(service: string, account: string);
    getPassword(): Promise<string | null>;
    setPassword(password: string): Promise<void>;
    deleteCredential(): Promise<void>;
  }
}
