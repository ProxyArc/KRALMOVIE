#!/usr/bin/env python3
import os, sys, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path

OUT = Path("/home/hatch/workspace/apk-build/android/libs")
OUT.mkdir(parents=True, exist_ok=True)
NS = "{http://maven.apache.org/POM/4.0.0}"

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()

def pom_url(group, artifact, version):
    path = f"{group.replace('.', '/')}/{artifact}/{version}/{artifact}-{version}.pom"
    if group.startswith("androidx.") or group.startswith("com.google.android"):
        return f"https://dl.google.com/dl/android/maven2/{path}"
    return f"https://repo1.maven.org/maven2/{path}"

def art_url(group, artifact, version, ext):
    path = f"{group.replace('.', '/')}/{artifact}/{version}/{artifact}-{version}.{ext}"
    if group.startswith("androidx.") or group.startswith("com.google.android"):
        return f"https://dl.google.com/dl/android/maven2/{path}"
    return f"https://repo1.maven.org/maven2/{path}"

def parse_pom(data):
    root = ET.fromstring(data)
    props = {}
    props_el = root.find(f"{NS}properties")
    if props_el is not None:
        for child in props_el:
            props[child.tag.replace(NS, "")] = (child.text or "").strip()
    parent = root.find(f"{NS}parent")
    parent_info = None
    if parent is not None:
        def txt(tag):
            el = parent.find(f"{NS}{tag}")
            return el.text.strip() if el is not None and el.text else None
        parent_info = (txt("groupId"), txt("artifactId"), txt("version"))
    deps = []
    deps_el = root.find(f"{NS}dependencies")
    if deps_el is not None:
        for d in deps_el.findall(f"{NS}dependency"):
            def txt(tag):
                el = d.find(f"{NS}{tag}")
                return el.text.strip() if el is not None and el.text else None
            scope = txt("scope") or "compile"
            optional = txt("optional") == "true"
            deps.append({
                "group": txt("groupId"), "artifact": txt("artifactId"),
                "version": txt("version"), "type": txt("type") or "jar",
                "scope": scope, "optional": optional,
            })
    return props, parent_info, deps

def resolve_version(v, props, parent_props):
    if v is None:
        return None
    import re
    def repl(m):
        key = m.group(1)
        if key == "project.version":
            return props.get("project.version", "")
        return props.get(key, parent_props.get(key, m.group(0)))
    for _ in range(5):
        nv = re.sub(r"\$\{([^}]+)\}", repl, v)
        if nv == v:
            break
        v = nv
    return v if "${" not in v else None

seen = set()
queue = [("androidx.media3", "media3-exoplayer", "1.4.1", "aar")]
downloaded = []

while queue:
    group, artifact, version, ext = queue.pop(0)
    key = f"{group}:{artifact}:{version}"
    if key in seen:
        continue
    seen.add(key)
    print(f"== {key} ({ext})", flush=True)
    try:
        pom_data = fetch(pom_url(group, artifact, version))
    except Exception as e:
        print(f"  POM failed: {e}")
        continue
    props, parent_info, deps = parse_pom(pom_data)
    parent_props = {}
    if parent_info and all(parent_info):
        try:
            pdata = fetch(pom_url(*parent_info))
            parent_props, _, _ = parse_pom(pdata)
        except Exception as e:
            print(f"  parent POM failed: {e}")
    # download artifact
    try:
        data = fetch(art_url(group, artifact, version, ext))
        out = OUT / f"{artifact}-{version}.{ext}"
        out.write_bytes(data)
        downloaded.append(str(out))
        print(f"  downloaded {len(data)} bytes -> {out.name}")
    except Exception as e:
        print(f"  artifact failed ({ext}): {e}")
        if ext == "aar":
            # try jar fallback
            try:
                data = fetch(art_url(group, artifact, version, "jar"))
                out = OUT / f"{artifact}-{version}.jar"
                out.write_bytes(data)
                downloaded.append(str(out))
                print(f"  jar fallback {len(data)} bytes")
            except Exception as e2:
                print(f"  jar fallback failed: {e2}")
    for d in deps:
        if d["scope"] not in ("compile", "runtime"):
            continue
        if d["optional"]:
            continue
        v = resolve_version(d["version"], props, parent_props)
        if not v:
            print(f"  skip unresolved {d['group']}:{d['artifact']} version={d['version']}")
            continue
        queue.append((d["group"], d["artifact"], v, d["type"]))

print("\nDownloaded:")
for p in downloaded:
    print(p)
