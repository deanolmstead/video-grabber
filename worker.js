// Video Grabber proxy — a Cloudflare Worker that fetches a URL server-side
// and returns it with CORS headers, so the GitHub Pages tool can read pages
// and download video files without relying on flaky public relays.
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create Worker →
// paste this in, name it e.g. "video-grabber-proxy", Deploy.
// Then the Pages tool calls: https://<worker-url>/?url=<encoded target>
//
// Streams the upstream body straight through, so large files are fine.

export default {
  async fetch(request) {
    // Only serve the Video Grabber page itself, so the worker doesn't
    // become a public open proxy. Browsers always send Origin on fetch.
    const origin = request.headers.get("Origin") || "";
    if (origin && origin !== "https://deanolmstead.github.io") {
      return new Response("Not allowed", { status: 403 });
    }
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) {
      return new Response("Usage: ?url=<encoded URL to fetch>", { status: 400 });
    }
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response("Bad URL", { status: 400 });
    }
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      return new Response("Only http/https URLs", { status: 400 });
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          "Accept": "*/*",
          "Referer": targetUrl.origin + "/",
        },
      });
    } catch (e) {
      return new Response("Upstream fetch failed: " + e.message, { status: 502 });
    }

    const headers = new Headers(upstream.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Type");
    headers.delete("content-security-policy");
    headers.delete("x-frame-options");
    headers.delete("content-encoding"); // body is passed through decoded

    return new Response(upstream.body, {
      status: upstream.status,
      headers: headers,
    });
  },
};
