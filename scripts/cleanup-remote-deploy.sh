#!/usr/bin/env bash
# 在 Linux SSH 主机上，用 LCode 的 SSH 登录账号执行；先退出该账号的 LCode 客户端。
set -euo pipefail

deploy_root="$HOME/.lcode/server"
deploy_uid=$(id -u)
deploy_pattern='/[.]lcode/server/([.]deploy[.]lock[.]holder-[[:xdigit:]-]+[.]sh|asset-cache/)'

if [ ! -d "$deploy_root" ]; then
  printf '没有 LCode 远端安装目录，无需清理。\n'
  exit 0
fi
command -v pgrep >/dev/null
command -v pkill >/dev/null

printf '只停止当前 UID=%s 的 LCode 部署进程：\n' "$deploy_uid"
pgrep -u "$deploy_uid" -f "$deploy_pattern" || true
pkill -TERM -u "$deploy_uid" -f "$deploy_pattern" || true
sleep 2
pkill -KILL -u "$deploy_uid" -f "$deploy_pattern" || true
sleep 1
if pgrep -u "$deploy_uid" -f "$deploy_pattern" >/dev/null; then
  printf '部署进程尚未退出，保留锁。请检查后再执行。\n' >&2
  exit 1
else
  deploy_query_status=$?
  if [ "$deploy_query_status" -ne 1 ]; then
    printf '无法确认部署进程是否退出，保留锁。\n' >&2
    exit "$deploy_query_status"
  fi
fi

# 只删除固定安装目录下的部署锁与辅助文件，保留组件、会话和项目文件。
rm -rf -- "$deploy_root/.deploy.lock"
find "$deploy_root" -maxdepth 1 -type f \
  \( -name '.deploy.lock.holder-*.sh' -o -name '.deploy.lock.control-*' \) -delete
find "$deploy_root" -maxdepth 1 -type d -name '.deploy.lock.stale-*' -exec rm -rf -- {} +
if [ -d "$deploy_root/asset-cache/components" ]; then
  # 旧心跳可能把 lock 目录重新 touch 成普通文件，两种形态都只在 platform/component/cache 三层清理。
  find "$deploy_root/asset-cache/components" -mindepth 3 -maxdepth 3 \
    \( -name '*.lock' -o -name '*.lock.holder-*.sh' -o -name '*.lock.control-*' -o -name '*.lock.stale-*' \) \
    \( -type d -o -type f \) -exec rm -rf -- {} +
fi
printf '旧部署进程和锁已清理。更新到修复版 LCode 后重新连接。\n'
