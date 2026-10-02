#!/usr/bin/env python3
"""Phase 3 部署驗證：對已部署的 Worker 跑登入、權限、CRUD、CORS 與 GAS 直連測試。

用法：
  python3 scripts/smoke_test.py <WORKER_URL> [--gas <GAS_URL>] [--readonly]

PIN 會在執行時以隱藏輸入詢問，不會出現在畫面、指令紀錄或任何檔案。
--readonly：只測登入、權限拒絕、CORS，不新增或刪除任何資料（正式環境建議使用）。
完整模式會建立專案「__PHASE3_SMOKE_TEST__」並在最後刪除。
"""
import argparse, getpass, json, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

TEST_PROJECT = "__PHASE3_SMOKE_TEST__"
ORIGIN = "https://ethanchen1216.github.io"
# Cloudflare 會擋 Python 預設的 User-Agent（error 1010），改用自訂名稱
USER_AGENT = "engineering-log-smoke-test/1.0"
results = []


def call(base, method, path, body=None, token=None, origin=None):
    headers = {"User-Agent": USER_AGENT}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = "Bearer " + token
    if origin:
        headers["Origin"] = origin
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw, status, hdrs = r.read(), r.status, r.headers
    except urllib.error.HTTPError as e:
        raw, status, hdrs = e.read(), e.code, e.headers
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        payload = {}
    return status, payload, hdrs


def check(name, cond, detail=""):
    results.append(cond)
    print(("  ✅ " if cond else "  ❌ ") + name + ("" if cond else f"  → {detail}"))


def expect_ok(name, res):
    status, body, _ = res
    check(name, status == 200 and body.get("success") is True, f"{status} {body.get('error')} {body.get('message')}")
    return body.get("data")


def expect_err(name, res, code):
    status, body, _ = res
    check(name, body.get("success") is False and body.get("error") == code, f"{status} {body.get('error')} {body.get('message')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("worker_url")
    ap.add_argument("--gas", help="GAS 網址（測試繞過 Worker 直接呼叫是否被拒絕）")
    ap.add_argument("--readonly", action="store_true")
    args = ap.parse_args()
    base = args.worker_url.rstrip("/")

    pin_worker = getpass.getpass("師傅 PIN（不會顯示）：")
    pin_admin = getpass.getpass("主管 PIN（不會顯示）：")
    tw = datetime.now(timezone(timedelta(hours=8)))
    today, yesterday = tw.strftime("%Y-%m-%d"), (tw - timedelta(days=1)).strftime("%Y-%m-%d")

    print("\n[1] 基本")
    expect_ok("health", call(base, "GET", "/health"))

    print("\n[2] 登入")
    tok_w = (expect_ok("師傅 PIN 登入", call(base, "POST", "/auth/login", {"pin": pin_worker})) or {})
    tok_a = (expect_ok("主管 PIN 登入", call(base, "POST", "/auth/login", {"pin": pin_admin})) or {})
    check("師傅角色 = worker", tok_w.get("role") == "worker", tok_w.get("role"))
    check("主管角色 = admin", tok_a.get("role") == "admin", tok_a.get("role"))
    wrong = "000000" if "000000" not in (pin_worker, pin_admin) else "000001"
    expect_err("錯誤 PIN", call(base, "POST", "/auth/login", {"pin": wrong}), "INVALID_PIN")
    tw_, ta_ = tok_w.get("token"), tok_a.get("token")
    if not (tw_ and ta_):
        print("\n登入失敗，無法繼續。")
        sys.exit(1)

    print("\n[3] Token 驗證")
    expect_err("沒有 token", call(base, "GET", "/logs"), "UNAUTHORIZED")
    h, p, s = ta_.split(".")
    expect_err("竄改簽章", call(base, "GET", "/logs", token=f"{h}.{p}.{s[:-2]}AA"), "UNAUTHORIZED")
    expect_err("亂碼 token", call(base, "GET", "/logs", token="abc.def.ghi"), "UNAUTHORIZED")

    print("\n[4] CORS")
    st, _, hd = call(base, "OPTIONS", "/logs", origin=ORIGIN)
    check("GitHub Pages 預檢允許", st == 204 and hd.get("Access-Control-Allow-Origin") == ORIGIN, st)
    st, _, hd = call(base, "OPTIONS", "/logs", origin="https://evil.example")
    check("其他網站被拒", st == 403 and not hd.get("Access-Control-Allow-Origin"), st)

    print("\n[5] 權限（不寫入資料的部分）")
    expect_ok("師傅可讀取日誌", call(base, "GET", "/logs", token=tw_))
    expect_ok("主管可讀取日誌", call(base, "GET", "/logs", token=ta_))
    expect_err("師傅不可刪除單筆", call(base, "DELETE", "/logs/ID_none?project=x", token=tw_), "FORBIDDEN")
    expect_err("師傅不可刪除專案", call(base, "DELETE", "/projects/" + urllib.parse.quote(TEST_PROJECT), token=tw_), "FORBIDDEN")

    if not args.readonly:
        print(f"\n[6] CRUD 與當天規則（測試專案 {TEST_PROJECT}）")
        def log(i, date, content):
            return {"id": f"ID_SMOKE_{i}", "date": date, "project": TEST_PROJECT, "weather": "晴天",
                    "workCategory": "結構", "workType": "鋼筋", "workerCount": '{"鋼筋":"2"}', "content": content}
        created = expect_ok("師傅新增當天", call(base, "POST", "/logs", log(1, today, "smoke"), token=tw_)) or {}
        check("回傳日誌人數格式正確", created.get("workerCount") == "鋼筋:2人", created.get("workerCount"))
        expect_ok("師傅新增昨天", call(base, "POST", "/logs", log(2, yesterday, "smoke"), token=tw_))
        expect_ok("師傅修改當天", call(base, "PUT", "/logs/ID_SMOKE_1", log(1, today, "改"), token=tw_))
        expect_err("師傅修改昨天被拒", call(base, "PUT", "/logs/ID_SMOKE_2", log(2, today, "偷改"), token=tw_), "FORBIDDEN")
        expect_ok("主管修改昨天", call(base, "PUT", "/logs/ID_SMOKE_2", log(2, yesterday, "主管改"), token=ta_))
        expect_err("修改不存在的日誌", call(base, "PUT", "/logs/ID_SMOKE_NONE", log(9, today, "x"), token=ta_), "NOT_FOUND")
        expect_ok("主管刪除單筆", call(base, "DELETE", "/logs/ID_SMOKE_1?project=" + urllib.parse.quote(TEST_PROJECT), token=ta_))
        d = expect_ok("主管刪除整個專案", call(base, "DELETE", "/projects/" + urllib.parse.quote(TEST_PROJECT), token=ta_)) or {}
        check("刪除筆數 = 1", d.get("deleted") == 1, d)
        rows = [l for l in (call(base, "GET", "/logs", token=ta_)[1].get("data") or []) if l.get("project") == TEST_PROJECT]
        check("測試資料已全部清除", not rows, len(rows))

    if args.gas:
        print("\n[7] 繞過 Worker 直接呼叫 GAS")
        def gas(method, body=None):
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(args.gas, data=data, method=method, headers={"Content-Type": "text/plain", "User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        check("GET 被拒", gas("GET").get("code") == "UNAUTHORIZED", "REQUIRE_SECRET 尚未設為 true？")
        check("沒有密鑰被拒", gas("POST", {"action": "getLogs"}).get("code") == "UNAUTHORIZED")
        check("錯誤密鑰被拒", gas("POST", {"action": "getLogs", "secret": "wrong"}).get("code") == "UNAUTHORIZED")

    passed = sum(results)
    print(f"\n結果：{passed}/{len(results)} 通過")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
