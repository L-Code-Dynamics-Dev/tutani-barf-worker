#!/usr/bin/env python3
"""Nahraje kalkulačku na FTP obchod.tutani.cz a zapíše verzi → projeví se hned.

  TUTANI_SFTP_USER=… TUTANI_SFTP_PASS=… python3 scripts/nasadit-frontend.py          # dry-run
  TUTANI_SFTP_USER=… TUTANI_SFTP_PASS=… python3 scripts/nasadit-frontend.py --live

Pořadí: node --check → záloha na serveru → upload JS/CSS (dočasné jméno + rename)
→ ověření CDN pod NOVOU verzí → teprve pak verze.txt (zákazníci přepnou až na
ověřené soubory). Verze = prvních 12 znaků SHA-256 obsahu JS+CSS.
Rollback: nahrát zálohu `*.bak-<čas>` zpět a spustit znovu.
"""
import base64, hashlib, os, subprocess, sys, time
import paramiko  # pinned 3.5.0

HOST, FP = "ftp.myshoptet.com", "bNX2DEUrb+uve8s22CVEa8Z1dzLAjUZKQXEpj5wLOxU"
DIR = "upload/lcode"
CDN = "https://cdn.myshoptet.com/usr/obchod.tutani.cz/user/documents/" + DIR + "/"
SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
FILES = ["konfigurator.js", "konfigurator.css"]


def main():
    live = "--live" in sys.argv
    chk = subprocess.run(["node", "--check", os.path.join(SRC, "konfigurator.js")], capture_output=True, text=True)
    if chk.returncode:
        raise SystemExit("STOP node --check:\n" + chk.stderr)
    data = {f: open(os.path.join(SRC, f), "rb").read() for f in FILES}
    verze = hashlib.sha256(b"".join(data[f] for f in FILES)).hexdigest()[:12]
    print("verze", verze, {f: len(d) for f, d in data.items()})
    if not live:
        print("DRY-RUN, nic nenahráno (--live)"); return
    t = paramiko.Transport((HOST, 22)); t.start_client(timeout=30)
    k = t.get_remote_server_key()
    if k.get_name() != "ssh-ed25519" or base64.b64encode(hashlib.sha256(k.asbytes()).digest()).decode().rstrip("=") != FP:
        raise SystemExit("STOP: host key nesedí")
    t.auth_password(os.environ["TUTANI_SFTP_USER"], os.environ["TUTANI_SFTP_PASS"])
    s = paramiko.SFTPClient.from_transport(t)
    try:
        ts = int(time.time())
        for f in FILES:
            r = f"{DIR}/{f}"
            try:
                with s.open(r, "rb") as fh: old = fh.read()
                with s.open(f"{r}.bak-{ts}", "wb") as fh: fh.write(old)
            except IOError:
                pass
            with s.open(r + ".uploading", "wb") as fh: fh.write(data[f])
            if s.stat(r + ".uploading").st_size != len(data[f]):
                raise SystemExit("STOP: velikost nesedí " + f)
            try: s.remove(r)
            except IOError: pass
            s.rename(r + ".uploading", r)
        for f in FILES:
            ok = False
            for i in range(6):
                out = subprocess.run(["/usr/bin/curl", "-s", "-m", "30", f"{CDN}{f}?v={verze}"], capture_output=True).stdout
                if hashlib.sha256(out).digest() == hashlib.sha256(data[f]).digest(): ok = True; break
                time.sleep(5)
            if not ok:
                raise SystemExit(f"STOP: CDN nevrací nový {f} — verze.txt NEZMĚNĚNA, zákazníci jedou dál na staré verzi")
        with s.open(f"{DIR}/verze.txt", "w") as fh: fh.write(verze)
    finally:
        s.close(); t.close()
    out = subprocess.run(["/usr/bin/curl", "-s", "-m", "30", f"{CDN}verze.txt?t={int(time.time())}"], capture_output=True, text=True).stdout.strip()
    print("HOTOVO, verze.txt =", out, "(sedí)" if out == verze else "(NESEDÍ!)")


if __name__ == "__main__":
    main()
