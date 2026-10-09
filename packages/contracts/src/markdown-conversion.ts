/** Existing raw-file conversion wire values; execution remains in the backend adapter. */
export type MarkdownConversionFormat = "markdown" | "text";

export interface MarkdownConversionOptions {
  readonly output?: { readonly format?: MarkdownConversionFormat };
  readonly image?: { readonly descriptionLanguage?: "en" | "it" | "de" | "es" | "fr" | "pt" };
  readonly html?: { readonly hostname?: string; readonly cssSelector?: string };
  readonly pdf?: { readonly metadata?: boolean };
}

export interface RawMarkdownConversionRequest {
  readonly idempotency_key: string;
  readonly max_output_bytes: number;
  readonly max_tokens: number;
  readonly timeout_ms: number;
  readonly conversion_options?: MarkdownConversionOptions;
}
