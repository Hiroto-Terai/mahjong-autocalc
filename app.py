"""ローカルサーバーの起動スクリプト。

    python app.py                # http://127.0.0.1:8000
    python app.py --host 0.0.0.0 # 同じ Wi-Fi のスマホから使う場合
"""

from __future__ import annotations

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="麻雀 点数自動計算ツール")
    parser.add_argument("--host", default="127.0.0.1", help="待ち受けアドレス")
    parser.add_argument("--port", type=int, default=8000, help="ポート番号")
    parser.add_argument("--reload", action="store_true", help="開発用に自動リロードする")
    args = parser.parse_args()

    print(f"http://{args.host}:{args.port} を開いてください")
    uvicorn.run(
        "mahjong_autocalc.server:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
