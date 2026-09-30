/**
 * Types for `inbound-mail-worker.js`, which stays plain JavaScript because it
 * is uploaded to Cloudflare verbatim (no bundler). Only the spec imports it.
 */

export interface InboundMailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface InboundMailEnv {
  BFF_URL: string;
  INBOUND_MAIL_TOKEN: string;
}

export declare const INBOUND_MAIL_PATH: string;
export declare const REJECT_STATUSES: ReadonlySet<number>;
export declare const REJECT_TEXT: string;

declare const worker: {
  email(message: InboundMailMessage, env: InboundMailEnv): Promise<void>;
};
export default worker;
