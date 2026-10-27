/**
 * Wrapper fuer geheime Werte. Der Wert liegt in einem privaten Feld und taucht in
 * toString, JSON, util.inspect und Fehlermeldungen nie auf. Ausgelesen wird er nur
 * ueber reveal(), und das nur dort, wo er wirklich weitergegeben wird (Anbieter-API,
 * Verschluesselung fuer GitHub).
 */
const REDACTED = "[SecretValue]";

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  static from(value: string): SecretValue {
    return new SecretValue(value);
  }

  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/** Ersetzt jeden bekannten Wert in einem Text durch ***. Fuer Protokolle und Fehlermeldungen. */
export function redact(text: string, secrets: Iterable<SecretValue | string>): string {
  let out = text;
  for (const s of secrets) {
    const v = typeof s === "string" ? s : s.reveal();
    if (v.length >= 4) out = out.split(v).join("***");
  }
  return out;
}
