## GitHub Copilot Chat

- Extension Version: 0.27.3 (prod)
- VS Code: vscode/1.100.2
- OS: Windows

## Network

User Settings:
```json
  "github.copilot.advanced.debug.useElectronFetcher": true,
  "github.copilot.advanced.debug.useNodeFetcher": false,
  "github.copilot.advanced.debug.useNodeFetchFetcher": true
```

Connecting to https://api.github.com:
- DNS ipv4 Lookup: timed out after 10 seconds
- DNS ipv6 Lookup: Error (2061 ms): getaddrinfo ENOTFOUND api.github.com
- Proxy URL: None (1 ms)
- Electron fetch (configured): timed out after 10 seconds
- Node.js https: Error (1997 ms): Error: getaddrinfo ENOTFOUND api.github.com
    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26)
- Node.js fetch: timed out after 10 seconds
- Helix fetch: Error (1993 ms): FetchError: getaddrinfo ENOTFOUND api.github.com
    at Egt (c:\Users\Администратор\.vscode\extensions\github.copilot-chat-0.27.3\dist\extension.js:304:29579)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
    at kxr (c:\Users\Администратор\.vscode\extensions\github.copilot-chat-0.27.3\dist\extension.js:304:31605)
    at eS.fetch (c:\Users\Администратор\.vscode\extensions\github.copilot-chat-0.27.3\dist\extension.js:793:2495)
    at c:\Users\Администратор\.vscode\extensions\github.copilot-chat-0.27.3\dist\extension.js:823:134
    at Wb.h (file:///c:/Users/%D0%90%D0%B4%D0%BC%D0%B8%D0%BD%D0%B8%D1%81%D1%82%D1%80%D0%B0%D1%82%D0%BE%D1%80/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:119:41516)

Connecting to https://api.individual.githubcopilot.com/_ping:
- DNS ipv4 Lookup: timed out after 10 seconds
- DNS ipv6 Lookup: Error (27 ms): getaddrinfo ENOTFOUND api.individual.githubcopilot.com
- Proxy URL: None (16 ms)
- Electron fetch (configured): HTTP 200 (6758 ms)
- Node.js https: HTTP 200 (1952 ms)
- Node.js fetch: HTTP 200 (2208 ms)
- Helix fetch: HTTP 200 (2363 ms)

## Documentation

In corporate networks: [Troubleshooting firewall settings for GitHub Copilot](https://docs.github.com/en/copilot/troubleshooting-github-copilot/troubleshooting-firewall-settings-for-github-copilot).