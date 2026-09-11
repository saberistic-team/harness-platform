/** Stable native-runner/evidence failures, surfaced by the trusted gate. */
export class NativeBuilderError extends Error {
    constructor(readonly code: `NATIVE_${string}`, message: string = code) {
        super(message);
        this.name = "NativeBuilderError";
    }
}
