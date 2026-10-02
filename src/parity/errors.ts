/**
 * A user-facing input problem: the tool answers it with `ok: false`, the kind
 * and a plain sentence, never a stack trace.
 */
export class ParityInputError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "ParityInputError";
    this.kind = kind;
  }
}
