export const MARKDOWN_CONVERSION_MAX_NAME_BYTES = 256;
export const MARKDOWN_CONVERSION_MAX_CONTEXT_BYTES = 256;
export const MARKDOWN_CONVERSION_MAX_RESULT_ID_BYTES = 256;
export const MARKDOWN_CONVERSION_MAX_MIME_BYTES = 256;
export const MARKDOWN_CONVERSION_MAX_ERROR_BYTES = 512;
export const MARKDOWN_CONVERSION_MAX_TIMEOUT_MS = 300_000;
/** Application admission bound; this is not a claim about a provider limit. */
export const MARKDOWN_CONVERSION_MAX_INPUT_BYTES = 256 * 1024;

export type MarkdownConversionFormat = "markdown" | "text";

export interface MarkdownConversionOptions {
  readonly output?: { readonly format?: MarkdownConversionFormat };
  readonly image?: { readonly descriptionLanguage?: "en" | "it" | "de" | "es" | "fr" | "pt" };
  readonly html?: { readonly hostname?: string; readonly cssSelector?: string };
  readonly pdf?: { readonly metadata?: boolean };
}

export interface MarkdownConversionContext {
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly input_sha256: string;
  readonly profile_generation: string;
}

export interface MarkdownConversionBounds {
  readonly max_output_bytes: number;
  readonly max_tokens: number;
  readonly timeout_ms: number;
}

export interface MarkdownConversionInput {
  readonly name: string;
  readonly blob: Blob;
  readonly context: MarkdownConversionContext;
  readonly bounds: MarkdownConversionBounds;
  readonly conversion_options?: MarkdownConversionOptions;
  readonly signal?: AbortSignal;
}

/** Structural shape of the current Workers AI binding used by the adapter. */
export interface WorkersAiMarkdownBinding {
  toMarkdown(
    file: { readonly name: string; readonly blob: Blob },
    options?: { readonly conversionOptions?: MarkdownConversionOptions },
  ): Promise<unknown>;
}

export interface MarkdownConversionObservation {
  readonly disposition: "CONVERTED";
  readonly context: MarkdownConversionContext;
  readonly provider_result_id: string;
  readonly name: string;
  readonly detected_mime: string;
  readonly format: MarkdownConversionFormat;
  readonly tokens: number;
  readonly data: string;
  readonly data_sha256: string;
  readonly data_bytes: number;
}

export type MarkdownConversionFailureCode =
  | "INPUT_INVALID"
  | "ABORTED"
  | "TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "RESPONSE_INVALID"
  | "EMPTY_OUTPUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "TOKEN_LIMIT_EXCEEDED";

export interface MarkdownConversionFailure {
  readonly disposition: "FAILED";
  readonly code: MarkdownConversionFailureCode;
  readonly context?: MarkdownConversionContext;
}

export type MarkdownConversionOutcome = MarkdownConversionObservation | MarkdownConversionFailure;

export interface MarkdownConversionAdapter {
  convert(input: MarkdownConversionInput): Promise<MarkdownConversionOutcome>;
}
