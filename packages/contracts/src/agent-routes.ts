const resource = '[A-Za-z0-9_-]{1,100}';
const allowedRoutes: [string, RegExp][] = [
  ['GET', /^\/(identity|status|providers|workspaces|snapshot|events)$/],
  ['GET', /^\/fs\/(roots|directories)$/],
  ['POST', /^\/fs\/directories$/],
  ['POST', /^\/workspaces\/open$/],
  ['POST', new RegExp(`^/workspaces/${resource}/terminals$`)],
  ['GET', new RegExp(`^/workspaces/${resource}/terminals/${resource}$`)],
  ['POST', new RegExp(`^/workspaces/${resource}/terminals/${resource}/(input|resize|close)$`)],
  ['GET', new RegExp(`^/workspaces/${resource}/(tree|file|metadata|changes|conversations)$`)],
  ['POST', new RegExp(`^/workspaces/${resource}/conversations$`)],
  ['POST', new RegExp(`^/workspaces/${resource}/images$`)],
  ['POST', new RegExp(`^/workspaces/${resource}/(uploads|downloads|files/manage)$`)],
  ['GET', new RegExp(`^/workspaces/${resource}/downloads/${resource}$`)],
  ['GET', new RegExp(`^/workspaces/${resource}/images/${resource}$`)],
  ['GET', new RegExp(`^/workspaces/${resource}/native-sessions$`)],
  ['POST', new RegExp(`^/workspaces/${resource}/native-sessions/import$`)],
  ['GET', new RegExp(`^/conversations/${resource}$`)],
  ['POST', new RegExp(`^/conversations/${resource}/runs$`)],
  ['POST', new RegExp(`^/conversations/${resource}/title$`)],
  ['POST', new RegExp(`^/conversations/${resource}/reply$`)],
  ['POST', new RegExp(`^/conversations/${resource}/takeover(/preview)?$`)],
  ['POST', new RegExp(`^/runs/${resource}/cancel$`)],
  ['POST', new RegExp(`^/runs/${resource}/rollback(/preview)?$`)],
  ['POST', new RegExp(`^/conversations/${resource}/fork$`)],
  ['POST', new RegExp(`^/interactions/${resource}/answer$`)],
  ['GET', /^\/providers\/(codex|kimi|claude)\/(account|models|quota)$/],
  ['GET', /^\/providers\/codex\/accounts$/],
  ['POST', /^\/providers\/codex\/accounts$/],
  ['POST', /^\/providers\/codex\/accounts\/[a-f0-9-]{36}\/delete$/],
  ['POST', /^\/providers\/(codex|kimi|claude)\/login(\/cancel)?$/],
  ['POST', /^\/providers\/claude\/login\/code$/],
  ['GET', /^\/providers\/codex\/sessions$/],
  ['POST', /^\/providers\/codex\/sessions\/import$/],
];
export function isAllowedAgentRoute(method: string, path: string): boolean {
  const scoped = /^\/accounts\/([a-f0-9-]{36})(\/.*)$/.exec(path);
  if (scoped) {
    if (scoped[2] === '/connect') return method === 'POST';
    if (scoped[2].includes('/accounts')) return false;
    path = scoped[2];
  }
  return allowedRoutes.some(([m, re]) => m === method && re.test(path));
}
