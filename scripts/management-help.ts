/** Shared post-install and on-demand instructions, matched to the actual run mode. */
export function managementHelp(mode: 'systemd' | 'foreground' | 'unknown' = 'unknown'): string {
  const lines = [
    '日常管理（在 Relay 项目目录执行）：',
    '  ./relay info       查看访问地址、账号和密码',
    '  ./relay status     查看运行状态',
    '  ./relay help       再次查看这些说明',
  ];
  if (mode !== 'foreground')
    lines.push(
      '',
      '后台服务模式：',
      '  ./relay start      启动项目',
      '  ./relay stop       关闭项目',
      '  ./relay restart    重启项目',
      '  ./relay logs       查看实时日志（Ctrl+C 退出日志，不停止项目）',
    );
  if (mode !== 'systemd')
    lines.push(
      '',
      '前台运行模式：',
      '  ./relay start      启动项目，日志显示在当前终端',
      '  Ctrl+C             在运行终端关闭项目',
      '  重启项目：先按 Ctrl+C 停止，再运行 ./relay start',
      '  ./relay service    安装并启动后台服务（需 systemd，先停止前台进程）',
    );
  lines.push('', '关闭或重启前请等待活动任务结束。关闭不会删除账号、配置或历史记录。');
  return lines.join('\n');
}
