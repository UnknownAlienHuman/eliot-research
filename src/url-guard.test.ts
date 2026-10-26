import { afterEach, describe, expect, it, vi } from "vitest";
import { UrlGuardError, captureUrl, validateSourceUrl } from "./url-guard";
import type { UrlGuardErrorCode, UrlGuardReason } from "./url-guard";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal inline fetch stub: no network-mock framework, per-test handlers. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    (input: unknown, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      return Promise.resolve(handler(url, init ?? {}));
    },
  );
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: UrlGuardErrorCode,
  reason: UrlGuardReason,
): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UrlGuardError);
    const guardError = error as UrlGuardError;
    expect(guardError.code).toBe(code);
    expect(guardError.reason).toBe(reason);
    expect(guardError.status).toBe(code === "invalid" ? 400 : 503);
    return (error as Error).message;
  }
  throw new Error("Expected the promise to reject, but it resolved.");
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe("validateSourceUrl", () => {
  it("accepts a public https URL", () => {
    expect(validateSourceUrl("https://example.com/papers/1").href).toBe("https://example.com/papers/1");
  });

  it("accepts an explicit 443 port and keeps query and fragment", () => {
    const url = validateSourceUrl("HTTPS://Sub.Example.COM:443/a?b=c#d");
    expect(url.hostname).toBe("sub.example.com");
    expect(url.href).toBe("https://sub.example.com/a?b=c#d");
  });

  it.each([
    "http://example.com/",
    "ftp://example.com/file",
    "example.com/no-scheme",
    "",
    "   ",
  ])("rejects non-https or unparsable input %j", (input) => {
    expect(() => validateSourceUrl(input)).toThrow(UrlGuardError);
  });

  it.each([
    "https://user@example.com/",
    "https://user:pass@example.com/",
    "https://example.com@attacker.com/",
  ])("rejects credentials %j", (input) => {
    expect(() => validateSourceUrl(input)).toThrow(UrlGuardError);
  });

  it.each([
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://192.168.1.1/",
    "https://172.16.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://0.0.0.0/",
    "https://[::]/",
    "https://93.184.216.34/",
  ])("rejects IP literals %j", (input) => {
    expect(() => validateSourceUrl(input)).toThrow(UrlGuardError);
  });

  it.each([
    "https://2130706433/",
    "https://0x7f000001/",
    "https://0x7f.0.0.1/",
    "https://0177.0.0.1/",
    "https://%31%32%37%2e%30%2e%30%2e%31/",
    "https://[::1]/",
    "https://[2001:db8::1]/",
  ])("rejects encoded and non-standard IP forms %j", (input) => {
    expect(() => validateSourceUrl(input)).toThrow(UrlGuardError);
  });

  it.each([
    "https://localhost/",
    "https://LOCALHOST/",
    "https://localhost./",
    "https://app.localhost/",
    "https://printer.local/",
    "https://db.internal/",
    "https://intranet",
  ])("rejects loopback, private and single-label names %j", (input) => {
    expect(() => validateSourceUrl(input)).toThrow(UrlGuardError);
  });

  it.each(["https://example.com:8080/", "https://example.com:80/"])(
    "rejects non-default ports %j",
    (input) => {
      expect(() => validateSourceUrl(input)).toThrow(UrlGuardError);
    },
  );
});

describe("captureUrl", () => {
  it("fetches with manual redirects and returns bytes, mime type, filename and final URL", async () => {
    stubFetch(async (url, init) => {
      expect(init.redirect).toBe("manual");
      expect(url).toBe("https://example.com/paper");
      return new Response("hello", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "content-disposition": 'attachment; filename="paper.pdf"' },
      });
    });
    const out = await captureUrl("https://example.com/paper");
    expect(new TextDecoder().decode(out.bytes)).toBe("hello");
    expect(out.mimeType).toBe("text/html");
    expect(out.filename).toBe("paper.pdf");
    expect(out.url).toBe("https://example.com/paper");
  });

  it("falls back to the path segment and a generic mime type", async () => {
    stubFetch(async () => new Response(null, { status: 200 }));
    const out = await captureUrl("https://example.com/files/report.pdf");
    expect(out.bytes.length).toBe(0);
    expect(out.mimeType).toBe("application/octet-stream");
    expect(out.filename).toBe("report.pdf");
  });

  it("does not touch the network when validation fails", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return new Response("x", { status: 200 });
    });
    await rejectsWithCode(captureUrl("http://example.com/plain"), "invalid", "blocked");
    expect(calls).toBe(0);
  });

  it("rejects an http downgrade redirect", async () => {
    stubFetch(async (url) =>
      url === "https://example.com/start" ? redirectTo("http://example.com/plain") : new Response("x", { status: 200 }),
    );
    await rejectsWithCode(captureUrl("https://example.com/start"), "invalid", "blocked");
  });

  it("rejects a redirect to an IP literal", async () => {
    stubFetch(async (url) =>
      url === "https://example.com/start" ? redirectTo("https://127.0.0.1/") : new Response("x", { status: 200 }),
    );
    await rejectsWithCode(captureUrl("https://example.com/start"), "invalid", "blocked");
  });

  it("follows a relative redirect and reports the final URL", async () => {
    stubFetch(async (url) =>
      url === "https://example.com/start" ? redirectTo("/next") : new Response("ok", { status: 200 }),
    );
    const out = await captureUrl("https://example.com/start");
    expect(out.url).toBe("https://example.com/next");
    expect(new TextDecoder().decode(out.bytes)).toBe("ok");
  });

  it("rejects a redirect without a Location", async () => {
    stubFetch(async () => new Response(null, { status: 302 }));
    await rejectsWithCode(captureUrl("https://example.com/start"), "invalid", "redirect");
  });

  it("rejects more than three redirects", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("/r4")) return new Response("done", { status: 200 });
      const hop = url.endsWith("/start") ? "1" : String(Number(url.slice(-1)) + 1);
      return redirectTo(`https://example.com/r${hop}`);
    });
    const message = await rejectsWithCode(captureUrl("https://example.com/start"), "invalid", "redirect");
    expect(message).toContain("3");
  });

  it("rejects error statuses without buffering an error page", async () => {
    stubFetch(async () => new Response("nope", { status: 404 }));
    const message = await rejectsWithCode(captureUrl("https://example.com/missing"), "unavailable", "bad_status");
    expect(message).toContain("404");
  });

  it("rejects an over-limit Content-Length before reading the body", async () => {
    stubFetch(async () => new Response("tiny", { status: 200, headers: { "content-length": "26214401" } }));
    await rejectsWithCode(captureUrl("https://example.com/big"), "invalid", "too_large");
  });

  it("stops a streaming body that exceeds 25 MiB", async () => {
    const big = new Uint8Array(10 * 1024 * 1024);
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(big);
              controller.enqueue(big);
              controller.enqueue(big);
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    await rejectsWithCode(captureUrl("https://example.com/stream"), "invalid", "too_large");
  });

  it("maps an aborted fetch to a timeout", async () => {
    stubFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    await rejectsWithCode(captureUrl("https://example.com/slow"), "unavailable", "timeout");
  });
});
