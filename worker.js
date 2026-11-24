// Video Grabber worker: CORS proxy + session downloads.
// ?url=<target>            — plain proxy fetch (used by the page for reads/downloads)
// ?grab=<pageUrl>          — load a page in a fresh session, list its video files
// ?grabfile=<pageUrl>&name=<filename> — reload the page in-session, pull that file
// Session mode exists for sites that sign their file links for the session
// (IP + cookies) that loaded the page: page and file are fetched here,
// back to back, so the signature matches.
// Deployed via Cloudflare Workers Builds from the video-grabber repo (main).
const ALLOWED_ORIGIN = "https://deanolmstead.github.io";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response("Not allowed", { status: 403 });
    }
    const url = new URL(request.url);
    const grab = url.searchParams.get("grab");
    const grabFile = url.searchParams.get("grabfile");
    const name = url.searchParams.get("name");
    if (grab) return pickerPage(grab);
    if (grabFile && name) return sessionDownload(grabFile, name);
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
          "User-Agent": UA,
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
    headers.delete("content-encoding");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: headers,
    });
  },
};

async function fetchSession(pageUrl) {
  const res = await fetch(pageUrl, {
    redirect: "follow",
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*" },
  });
  let raw = [];
  try { raw = res.headers.getSetCookie(); } catch (e) {}
  if (!raw || !raw.length) {
    const sc = res.headers.get("set-cookie");
    if (sc) raw = [sc];
  }
  const jar = (raw || []).map(function (c) { return c.split(";")[0]; }).filter(Boolean).join("; ");
  const text = await res.text();
  return { text: text, jar: jar, status: res.status };
}

function extractMedia(html, pageUrl) {
  const found = [];
  const seen = {};
  function nameOf(u) {
    try {
      const parts = new URL(u).pathname.split("/").filter(Boolean);
      return decodeURIComponent(parts[parts.length - 1] || "video.mp4");
    } catch (e) { return "video.mp4"; }
  }
  function push(u, main) {
    if (!u) return;
    try { u = new URL(u, pageUrl).href; } catch (e) { return; }
    if (!/^https?:/i.test(u) || seen[u]) return;
    seen[u] = true;
    found.push({ url: u, name: nameOf(u), main: !!main });
  }
  const og = html.match(/<meta[^>]+(?:og:video(?::secure_url|:url)?|twitter:player:stream)[^>]*>/gi) || [];
  og.forEach(function (tag) {
    const m = tag.match(/content="([^"]+)"/i);
    if (m) push(m[1].replace(/&amp;/g, "&"), true);
  });
  const re = /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|webm|mov|m4v|m3u8)(?:\?[^\s"'<>\\]*)?/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    push(m[0].replace(/\\\//g, "/").replace(/&amp;/g, "&"), false);
  }
  // Quoted paths, including relative ones (src="/html/mov_bbb.mp4") that
  // only resolve against the page URL — push() handles the resolution.
  const qre = /["']([^"'\s]+\.(?:mp4|webm|mov|m4v|m3u8)(?:\?[^"'\s]*)?)["']/gi;
  while ((m = qre.exec(html)) !== null) {
    push(m[1].replace(/&amp;/g, "&"), false);
  }
  function score(f) {
    if (f.main) return 1000000000;
    let s = 0;
    const res = f.name.match(/(\d{3,4})x(\d{3,4})/);
    if (res) s += parseInt(res[2], 10) * 10000;
    const kb = f.name.match(/(\d{3,5})k/i);
    if (kb) s += parseInt(kb[1], 10);
    if (/preview|\.20\.mp4$/i.test(f.name) || /\/lpp\//i.test(f.url)) s -= 500000000;
    return s;
  }
  found.sort(function (a, b) { return score(b) - score(a); });
  return found;
}

function htmlPage(title, body) {
  return new Response(
    "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width, initial-scale=1'>" +
    "<title>" + title + "</title><style>" +
    "body{background:#101012;color:#f4f2ec;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;" +
    "margin:0;padding:2rem 1rem;line-height:1.5}main{max-width:720px;margin:0 auto}" +
    "h1{font-size:1.6rem}a{color:#ff4b26}.item{display:block;background:#1a1a1e;border:1px solid #33333c;" +
    "border-radius:12px;padding:1rem 1.1rem;margin:.6rem 0;text-decoration:none;color:#f4f2ec}" +
    ".item b{word-break:break-all}.item span{color:#a7a49b;font-size:.85rem;word-break:break-all}" +
    "</style></head><body><main>" + body + "</main></body></html>",
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

async function pickerPage(pageUrl) {
  let session;
  try {
    session = await fetchSession(pageUrl);
  } catch (e) {
    return htmlPage("Session download", "<h1>Couldn't load that page</h1><p>The session fetch failed: " + esc(e.message) + "</p>");
  }
  const media = extractMedia(session.text, pageUrl);
  if (!media.length) {
    return htmlPage("Session download", "<h1>No video files on that page</h1><p>A fresh session load of the page didn't expose any downloadable video file.</p>");
  }
  const items = media.map(function (f) {
    const href = "?grabfile=" + encodeURIComponent(pageUrl) + "&name=" + encodeURIComponent(f.name);
    return "<a class='item' href='" + esc(href) + "'><b>" + esc(f.name) + "</b><br><span>" + esc(f.url) + "</span></a>";
  }).join("");
  return htmlPage(
    "Session download",
    "<h1>Pick the file to download</h1>" +
    "<p>Loaded fresh just now — clicking a file pulls it in the same session, so session-locked links work. Best quality is listed first.</p>" +
    items
  );
}

async function sessionDownload(pageUrl, wantedName) {
  let session;
  try {
    session = await fetchSession(pageUrl);
  } catch (e) {
    return htmlPage("Session download", "<h1>Couldn't load that page</h1><p>" + esc(e.message) + "</p>");
  }
  const media = extractMedia(session.text, pageUrl);
  const pick = media.filter(function (f) { return f.name === wantedName; })[0];
  if (!pick) {
    return htmlPage("Session download", "<h1>That file rotated</h1><p>The fresh page load didn't include " + esc(wantedName) + " — go back and pick from the list again.</p>");
  }
  if (/\.m3u8($|\?)/i.test(pick.url)) {
    return htmlPage("Session download", "<h1>That's a stream</h1><p>Session mode can't join streamed (HLS) files yet — try the regular Download button for it on the Video Grabber page.</p>");
  }
  let upstream;
  try {
    upstream = await fetch(pick.url, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "Referer": pageUrl,
        "Cookie": session.jar,
      },
    });
  } catch (e) {
    return htmlPage("Session download", "<h1>Download failed</h1><p>" + esc(e.message) + "</p>");
  }
  if (!upstream.ok) {
    return htmlPage("Session download", "<h1>Download refused</h1><p>The file server answered " + upstream.status + " even inside a fresh session. It may need a logged-in account or a full browser session.</p>");
  }
  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "video/mp4");
  const len = upstream.headers.get("Content-Length");
  if (len) headers.set("Content-Length", len);
  headers.set("Content-Disposition", "attachment; filename=\"" + pick.name.replace(/"/g, "") + "\"");
  return new Response(upstream.body, { status: 200, headers: headers });
}
