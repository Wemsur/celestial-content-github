# GitHub Releases

Celestial Launcher 的内容源插件（id：`github`）。

把 GitHub 仓库的 Release 当作可安装内容。GitHub 没有可浏览的内容目录，所以条目由你手动添加：填仓库地址，再决定从 Release 里挑哪个文件。

## 提供的内容

- 模组（`mod`）
- 资源包（`resourcepack`）
- 光影（`shader`）
- 数据包（`datapack`）

## 构建

```bash
pnpm install
pnpm build      # 产出 dist/index.js
pnpm typecheck  # 类型检查
```

## 类型

`types/content-source.d.ts` 是启动器内容源接口的**副本**，权威版本在
[Celestial-Plugin-Store](https://github.com/Wemsur/Celestial-Plugin-Store) 的 `sdk/` 下。
它只提供类型，没有运行时代码——构建产物里不含任何对它引用。

## 需要访问的域名

插件通过启动器的网络代理发请求，只能访问 `manifest.json` 里声明过的域名：

- `api.github.com`
- `github.com`
- `objects.githubusercontent.com`
- `release-assets.githubusercontent.com`

## 发布

打一个 `x.x.x` 或 `vx.x.x` 的 tag 并推送即可。工作流会构建、校验 tag 与
`manifest.json` 的版本一致、打包成 **`github.zip`**（不带版本号）挂到 Release。

商店索引里的下载地址指向 `releases/latest/download/github.zip`，所以**发布新版不需要
改商店**——启动器通过该链接所在的 Release 自动获得新版本。
