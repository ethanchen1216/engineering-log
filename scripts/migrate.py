#!/usr/bin/env python3
"""Phase 4 主管工具：Sheets → Firestore 遷移、逐筆比對、備份狀態。

用法：
  python3 scripts/migrate.py <WORKER_URL> <指令>

指令：
  status      備份狀態（待同步筆數、最後成功時間、最後完整核對；回滾前必看）
  dry-run     只分析 Sheets 資料，不寫入 Firestore
  migrate     遷移到 Firestore（需 MIGRATION_ENABLED=true、DATA_PROVIDER=gas）
  prune       遷移並刪除 Firestore 中 Sheets 沒有的資料（回滾後要切回 Firestore 前使用）
  compare     逐筆比對 Sheets 與 Firestore（必須 100% MATCH 才能切換）
  retry       立即重試待同步的備份
  full-sync   立即執行完整核對（含安全閥）

主管 PIN 會以隱藏輸入詢問，不會出現在畫面或紀錄中。
"""
import getpass, json, sys, urllib.error, urllib.request

USER_AGENT = "engineering-log-admin/1.0"  # Cloudflare 會擋 Python 預設的 User-Agent
COMMANDS = {
    "status":    ("GET",  "/admin/backup-status"),
    "dry-run":   ("POST", "/admin/migrate?dryRun=1"),
    "migrate":   ("POST", "/admin/migrate"),
    "prune":     ("POST", "/admin/migrate?prune=1"),
    "compare":   ("GET",  "/admin/compare"),
    "retry":     ("POST", "/admin/backup/retry"),
    "full-sync": ("POST", "/admin/backup/full-sync"),
}


def call(base, method, path, body=None, token=None):
    headers = {"User-Agent": USER_AGENT}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b"{}")
        except ValueError:
            return {"success": False, "error": f"HTTP {e.code}"}


def show_list(title, items, fmt, limit=20):
    if not items:
        return
    print(f"\n  {title}（{len(items)}）")
    for it in items[:limit]:
        print("    - " + fmt(it))
    if len(items) > limit:
        print(f"    …另外 {len(items) - limit} 筆")


def where(it):
    return f"{it.get('sheet')} 第 {it.get('row')} 列  id={it.get('id') or '（空白）'}"


def print_migrate(d):
    print(f"\n{'【DRY RUN：沒有寫入】' if d['dryRun'] else '【已寫入 Firestore】'}{'（含 prune）' if d['prune'] else ''}")
    print(f"  Sheets 總列數：{d['sheetsTotal']}")
    print(f"  有效：{d['valid']}")
    print(f"  新增：{d['inserted']}　更新：{d['updated']}　未變動：{d['unchanged']}　刪除（prune）：{d['pruned']}　失敗：{d['failed']}")
    show_list("缺少 ID（不會遷移）", d["missingId"], where)
    show_list("重複 ID（不會遷移）", d["duplicates"], where)
    show_list("格式錯誤（不會遷移）", d["invalid"], lambda i: where(i) + "  " + ",".join(i["reasons"]))
    show_list("警告（會遷移，請人工確認內容）", d["warnings"], lambda i: where(i) + "  " + i["warning"])
    show_list("寫入失敗", d["failures"], lambda i: json.dumps(i, ensure_ascii=False))


def print_compare(d):
    total = d["sheetsTotal"]
    print(f"\n  Sheets：{total} 列　Firestore：{d['firestoreTotal']} 筆")
    print(f"  MATCH：{d['MATCH']}")
    print(f"  MISMATCH：{len(d['MISMATCH'])}　MISSING_IN_FIRESTORE：{len(d['MISSING_IN_FIRESTORE'])}　EXTRA_IN_FIRESTORE：{len(d['EXTRA_IN_FIRESTORE'])}")
    show_list("MISMATCH", d["MISMATCH"], lambda m: m["id"] + "  " + "; ".join(f"{x['field']}: Sheets={x['sheets']!r} / Firestore={x['firestore']!r}" for x in m["diffs"]))
    show_list("MISSING_IN_FIRESTORE", d["MISSING_IN_FIRESTORE"], str)
    show_list("EXTRA_IN_FIRESTORE", d["EXTRA_IN_FIRESTORE"], str)
    show_list("缺少 ID", d["missingId"], where)
    show_list("重複 ID", d["duplicates"], where)
    show_list("格式錯誤", d["invalid"], lambda i: where(i) + "  " + ",".join(i["reasons"]))
    print("\n  結果：" + ("✅ 100% MATCH，可以進行切換" if d["allMatch"] else "❌ 未達 100% 一致，不可切換"))


def print_status(d):
    full = d.get("lastFullSync") or {}
    print(f"\n  待同步筆數：{d['pending']}（其中重試中：{d['retrying']}）")
    print(f"  最舊待同步時間：{d.get('oldestPendingAt') or '—'}")
    print(f"  最後成功同步：{d.get('lastSuccessAt') or '—'}")
    print(f"  最後失敗：{d.get('lastFailureAt') or '—'}　{d.get('lastError') or ''}")
    print(f"  最後完整核對：{full.get('at') or '—'}　結果：{full.get('result') or '—'} {full.get('reason') or ''}")
    if d.get("lastWarning"):
        print(f"  ⚠️ 最後警告：{d['lastWarning']}（{d.get('lastWarningAt')}）")
    print("\n  回滾準備：" + ("✅ 可以安全切回 GAS" if d["readyForRollback"] else "❌ 尚有未同步資料或尚未完成完整核對，請先執行 full-sync"))


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in COMMANDS:
        print(__doc__)
        sys.exit(2)
    base, cmd = sys.argv[1].rstrip("/"), sys.argv[2]
    pin = getpass.getpass("主管 PIN（不會顯示）：")
    login = call(base, "POST", "/auth/login", {"pin": pin})
    if not login.get("success"):
        print("登入失敗：", login.get("message") or login.get("error"))
        sys.exit(1)
    token = login["data"]["token"]
    method, path = COMMANDS[cmd]
    print(f"執行 {cmd} …（資料多時可能需要數十秒）")
    res = call(base, method, path, {} if method == "POST" else None, token)
    if not res.get("success"):
        print(f"\n失敗：{res.get('error')} {res.get('message') or ''}")
        sys.exit(1)
    d = res["data"]
    if cmd in ("dry-run", "migrate", "prune"):
        print_migrate(d)
    elif cmd == "compare":
        print_compare(d)
        sys.exit(0 if d["allMatch"] else 1)
    elif cmd == "status":
        print_status(d)
    else:
        print(json.dumps(d, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
