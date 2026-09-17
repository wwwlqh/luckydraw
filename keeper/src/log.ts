// Structured one-line logs.
//
// One line per decision, in `key=value` form so `grep round=12` finds a round's whole history in a terminal
// scrollback without a log shipper. Values that are not bare words are JSON-quoted, so a revert reason with a
// space in it cannot break the line into two fields.
//
// Nothing here ever receives a key: `config.ts` keeps `KEEPER_PRIVATE_KEY` out of every structure this module
// can be handed, and the only account this module prints is a public address. The one secret that can still
// reach a log line is the RPC endpoint, because provider errors quote the request URL and an operator RPC URL
// usually carries its API key; every string value is therefore passed through `redactUrls` on the way out.

export type LogValue = string | number | bigint | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;
export type LogLevel = "info" | "warn" | "error";

export type Logger = {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

const BARE = /^[A-Za-z0-9_:./@+-]+$/;

/**
 * Any absolute http(s) URL, including the surrounding quotes an error message often wraps it in.
 *
 * ethers puts the request URL into the message of a provider error - `server response 500 ... info={
 * "requestUrl": "https://host/v1/<key>" ... }` - and those messages are logged verbatim by `cycle_failed`,
 * `refused_to_start`, `fatal` and an undecodable skip reason. An operator RPC URL frequently *is* the
 * credential (a key in the path or the query), so no log line may carry one.
 */
const URL_LIKE = /\bhttps?:\/\/[^\s"'\\]*/gi;

/** A logged string with every absolute URL replaced by `<rpc>`. */
export function redactUrls(value: string): string {
  return value.replace(URL_LIKE, "<rpc>");
}

/** A field value as one log token: bare when it is already unambiguous, JSON-quoted otherwise. */
export function formatValue(value: LogValue): string {
  if (value === undefined) return "-";
  if (value === null) return "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const redacted = redactUrls(value);
  return BARE.test(redacted) && redacted.length > 0 ? redacted : JSON.stringify(redacted);
}

/** One log line, without its trailing newline. `ts` is an ISO-8601 UTC instant. */
export function formatLine(now: Date, level: LogLevel, event: string, fields?: LogFields): string {
  const parts = [`ts=${now.toISOString()}`, `level=${level}`, `event=${event}`];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

export type LoggerOptions = {
  write?: (line: string) => void;
  now?: () => Date;
};

/** A logger writing one line per call. The writer and the clock are injectable so tests can capture both. */
export function createLogger(options?: LoggerOptions): Logger {
  const write = options?.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const now = options?.now ?? ((): Date => new Date());
  const log = (level: LogLevel, event: string, fields?: LogFields): void => {
    write(formatLine(now(), level, event, fields));
  };
  return {
    log,
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}
