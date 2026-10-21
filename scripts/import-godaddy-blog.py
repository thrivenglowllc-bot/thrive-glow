# One-time import of the GoDaddy Website Builder blog (window._BLOG_DATA, Draft.js) into site-src/blog/. Kept for reference; new posts are written directly.
# Usage: python3 -I convert_blog.py <pages_dir> <site_src_dir> <img_cache_dir>
import json, sys, os, re, html, glob, subprocess, hashlib
from datetime import datetime

pages_dir, site_src, img_cache = sys.argv[1:4]
blog_dir = os.path.join(site_src, "blog")
img_out = os.path.join(blog_dir, "img")
os.makedirs(img_out, exist_ok=True)
os.makedirs(img_cache, exist_ok=True)

def esc(s): return html.escape(s, quote=True)

def fetch_img(src, hint):
    url = "https:" + src if src.startswith("//") else src
    url = url.split("/:/")[0]  # drop GoDaddy resize suffixes, get the original
    name = re.sub(r"[^A-Za-z0-9._-]", "-", url.rsplit("/", 1)[-1]) or "image"
    stem, ext = os.path.splitext(name)
    ext = ext.lower() if ext.lower() in (".jpg", ".jpeg", ".png", ".webp", ".gif") else ".jpg"
    key = hashlib.sha1(url.encode()).hexdigest()[:8]
    raw = os.path.join(img_cache, key + ext)
    if not os.path.exists(raw):
        for _ in range(5):
            r = subprocess.run(["curl", "-sS", "-m", "60", "-o", raw, url], capture_output=True)
            if r.returncode == 0 and os.path.getsize(raw) > 0: break
        else:
            print("  image failed:", url); return None
    from PIL import Image, ImageOps
    im = ImageOps.exif_transpose(Image.open(raw))
    alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
    out_name = f"{hint}-{key}." + ("png" if alpha else "jpg")
    out = os.path.join(img_out, out_name)
    if not os.path.exists(out):
        im.thumbnail((1400, 1400))
        if alpha: im.save(out, optimize=True)
        else: im.convert("RGB").save(out, "JPEG", quality=82, optimize=True, progressive=True)
    w, h = Image_size(out)
    return out_name, w, h

def Image_size(p):
    from PIL import Image
    with Image.open(p) as im: return im.size

def render_text(block, entity_map):
    text = block["text"]
    n = len(text)
    # per-character style sets and link targets
    styles = [set() for _ in range(n)]
    for r in block.get("inlineStyleRanges", []):
        for i in range(r["offset"], min(n, r["offset"] + r["length"])): styles[i].add(r["style"])
    links = [None] * n
    for r in block.get("entityRanges", []):
        e = entity_map.get(str(r["key"])) or {}
        if e.get("type") == "LINK":
            url = (e.get("data") or {}).get("url") or (e.get("data") or {}).get("href")
            for i in range(r["offset"], min(n, r["offset"] + r["length"])): links[i] = url
    out, i = [], 0
    while i < n:
        j = i
        while j < n and styles[j] == styles[i] and links[j] == links[i]: j += 1
        seg = html.escape(text[i:j], quote=False).replace("\n", "<br>")
        st = styles[i]
        if "BOLD" in st: seg = f"<strong>{seg}</strong>"
        if "ITALIC" in st: seg = f"<em>{seg}</em>"
        if "UNDERLINE" in st: seg = f"<u>{seg}</u>"
        if links[i]:
            u = links[i]
            ext = not u.startswith("/") and "thrivenglow.com" not in u
            seg = f'<a href="{esc(u)}"' + (' rel="noopener" target="_blank"' if ext else "") + f">{seg}</a>"
        out.append(seg); i = j
    return "".join(out)

def render(fc):
    global SLUG
    blocks, em = fc["blocks"], fc.get("entityMap", {})
    html_out, list_tag = [], None
    images = []
    def close_list():
        nonlocal list_tag
        if list_tag: html_out.append(f"</{list_tag}>"); list_tag = None
    for b in blocks:
        t = b["type"]
        if t in ("unordered-list-item", "ordered-list-item"):
            want = "ul" if t.startswith("un") else "ol"
            if list_tag != want: close_list(); html_out.append(f"<{want}>"); list_tag = want
            html_out.append(f"<li>{render_text(b, em)}</li>"); continue
        close_list()
        if t == "atomic":
            for r in b.get("entityRanges", []):
                e = em.get(str(r["key"])) or {}
                if e.get("type") == "DIVIDER": html_out.append("<hr>"); continue
                if e.get("type") == "IMAGE" and (e.get("data") or {}).get("src"):
                    got = fetch_img(e["data"]["src"], SLUG)
                    if got:
                        name, w, h = got; images.append(name)
                        alt = esc((e["data"].get("alt") or "").strip())
                        html_out.append(f'<figure><img src="../../img/{name}" alt="{alt}" width="{w}" height="{h}" loading="lazy"></figure>')
            continue
        if not b["text"].strip(): continue
        inner = render_text(b, em)
        if t == "header-one": html_out.append(f"<h2>{inner}</h2>")
        elif t in ("header-two", "header-three", "header-four"): html_out.append(f"<h3>{inner}</h3>")
        elif t == "blockquote": html_out.append(f"<blockquote>{inner}</blockquote>")
        else: html_out.append(f"<p>{inner}</p>")
    close_list()
    return "\n        ".join(html_out), images

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · {{{{name}}}}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{{{{site_url}}}}/{path}">
<meta property="og:type" content="{ogtype}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{{{{site_url}}}}/{path}">{ogimage}
<link rel="icon" href="{root}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&family=Petrona:wght@500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{root}assets/site.css?v=3">{ld}
</head>
<body>
<header class="site-head">
  <div class="wrap">
    <a class="brand" href="{root}">{{{{name}}}}</a>
    <nav><a class="hide-sm" href="{root}blog/">Blog</a><a class="hide-sm" href="{root}#programs">Programs</a><a href="{root}consultation/">Free consultation</a></nav>
  </div>
</header>
"""
FOOT = """
<footer class="site-foot">
  <div class="wrap">
    <p>{{contact_line}}</p>
    <p class="disclaimer">{{name}} offers education and wellness support. It is not medical care and does not diagnose, treat or cure disease, and it does not replace your doctor. © {{year}} {{legal_name}}.</p>
  </div>
</footer>
</body>
</html>
"""

def braces(s):  # keep {{ }} out of user content so the build step doesn't treat it as a token
    return s.replace("{{", "{&#8203;{").replace("}}", "}&#8203;}")

posts = []
for f in sorted(glob.glob(os.path.join(pages_dir, "*.html"))):
    s = open(f, encoding="utf-8", errors="ignore").read()
    i = s.find("_BLOG_DATA=")
    if i < 0: print("no data:", f); continue
    d, _ = json.JSONDecoder().raw_decode(s[i + len("_BLOG_DATA="):])
    p = d["post"]
    fc = json.loads(p["fullContent"])
    SLUG = p["slug"]
    print("post:", p["title"])
    body, imgs = render(fc)
    feat = None
    if p.get("featuredImage"):
        got = fetch_img(p["featuredImage"], p["slug"])
        if got: feat = got[0]
    date = datetime.fromisoformat((p.get("publishedDate") or p["date"]).replace("Z", "+00:00"))
    title = p["title"].strip()
    desc = (p.get("content") or "").strip()
    posts.append(dict(slug=p["slug"], title=title, desc=desc, date=date, feat=feat, body=body, imgs=imgs))

posts.sort(key=lambda x: x["date"], reverse=True)
for idx, p in enumerate(posts):
    path = f"blog/f/{p['slug']}/"
    d = os.path.join(blog_dir, "f", p["slug"]); os.makedirs(d, exist_ok=True)
    og = f'\n<meta property="og:image" content="{{{{site_url}}}}/blog/img/{p["feat"]}">' if p["feat"] else ""
    ld = {"@context": "https://schema.org", "@type": "BlogPosting", "headline": p["title"], "datePublished": p["date"].isoformat(), "author": {"@type": "Person", "name": "{{owner_name}}"}, "publisher": {"@type": "Organization", "name": "{{name}}"}}
    head = HEAD.format(title=esc(p["title"]), desc=esc(p["desc"]), path=path, ogtype="article", ogimage=og, root="../../../",
                       ld='\n<script type="application/ld+json">' + json.dumps(ld).replace("<", "\\u003c") + "</script>")
    hero = "" if (p["feat"] and p["feat"] in p["imgs"]) or not p["feat"] else f'<figure><img src="../../img/{p["feat"]}" alt="" loading="lazy"></figure>\n        '
    nav = []
    if idx + 1 < len(posts): nav.append(f'<a href="../{posts[idx+1]["slug"]}/">Older: {esc(posts[idx+1]["title"])}</a>')
    if idx > 0: nav.append(f'<a href="../{posts[idx-1]["slug"]}/">Newer: {esc(posts[idx-1]["title"])}</a>')
    page = head + f"""
<main class="prose post">
  <div class="wrap">
    <p class="fine"><a href="../../">All posts</a></p>
    <article>
      <h1>{esc(p['title'])}</h1>
      <p class="fine">{p['date'].strftime('%B %-d, %Y')} · {{{{owner_name}}}}</p>
      <div class="post-body">
        {hero}{braces(p['body'])}
      </div>
    </article>
    <aside class="post-cta">
      <h2>Want help finding your root cause?</h2>
      <p>Book a free 30-minute consultation and we’ll talk through what’s going on.</p>
      <a class="btn" href="../../../consultation/">Book a free consultation</a>
    </aside>
    <nav class="post-nav">{''.join(f'<p>{n}</p>' for n in nav)}</nav>
  </div>
</main>
""" + FOOT
    open(os.path.join(d, "index.html"), "w").write(page)

# index
items = "\n".join(f"""      <li>
        <a href="f/{p['slug']}/">{f'<img src="img/{p["feat"]}" alt="" loading="lazy">' if p['feat'] else '<span class="noimg"></span>'}</a>
        <div><p class="fine">{p['date'].strftime('%B %-d, %Y')}</p><h2><a href="f/{p['slug']}/">{esc(p['title'])}</a></h2><p>{esc(p['desc'])}</p></div>
      </li>""" for p in posts)
idx_html = HEAD.format(title="Blog", desc="Notes on gut health, hormones, cycle syncing, perimenopause and everyday wellness from {{owner_name}} at {{name}}.", path="blog/", ogtype="website", ogimage="", root="../", ld="") + f"""
<main class="prose">
  <div class="wrap">
    <h1>Blog</h1>
    <p class="lede">Gut health, hormones, cycle syncing and real life, from my own healing and my work with clients.</p>
    <ul class="post-list">
{items}
    </ul>
  </div>
</main>
""" + FOOT
open(os.path.join(blog_dir, "index.html"), "w").write(idx_html)
json.dump([{"slug": p["slug"], "title": p["title"], "date": p["date"].isoformat()} for p in posts], open(os.path.join(img_cache, "posts.json"), "w"), indent=1)
print(len(posts), "posts written")

# sitemap: list every post (idempotent)
sm_path = os.path.join(site_src, "sitemap.xml")
sm = open(sm_path).read()
sm = re.sub(r"\n  <url><loc>\{\{site_url\}\}/blog/f/[^<]*</loc></url>", "", sm)
post_urls = "".join(f"\n  <url><loc>{{{{site_url}}}}/blog/f/{p['slug']}/</loc><lastmod>{p['date'].date().isoformat()}</lastmod></url>" for p in posts)
sm = sm.replace("\n</urlset>", post_urls + "\n</urlset>")
open(sm_path, "w").write(sm)
