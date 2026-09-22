# 供应商 API Key 个人覆盖层保留

## 产品规则

1. `access.apiKeys` 和兼容字段 `access.apiKey` 属于同一个个人配置事实，任何一次 Provider 草稿保存都不得只保留其中一个而删除另一个。
2. Key 管理保存只在个人覆盖层基线上写入 `apiKey/apiKeys`，不得把继承的管理地址或其他 Access 字段物化为个人配置。
3. Key 管理保存生成的本次 Provider 草稿必须同时反映新的有效 Access 与个人 Access，后续同一编辑会话不能继续使用旧 Key 列表。
4. 旧版单 Key 草稿发生变化时，如果有效配置已经包含多 Key 列表，保存结果必须保留该列表，并只更新兼容主 Key。

## 状态所有者

- `personalConfig.access` 是 Renderer 提交给 Provider Settings Service 的稀疏个人事实。
- `config.access` 是 Registry 解析后的有效展示值，只作为继承读取基线，不能整对象复制到个人层。
- `ProviderDraftSave` 是连接草稿与 Key 草稿合并为单次 Provider 保存对象的唯一纯函数边界。

## 事件顺序

```text
Key 管理保存 → 在 personalConfig.access 写 apiKey + apiKeys
            → 同步更新本次草稿的 config.access
            → Provider Settings Service 保存个人覆盖层

后续连接草稿保存 → 读取个人 Access
                → 保留已有/有效 apiKeys
                → 只更新发生变化的 apiKey
```

## 验收场景

- 保存两个 Key 后再修改主 Key、Base URL 或切换供应商，两个 Key 均仍存在。
- 有效 Access 含 `apiKeyManagementUrl`、个人 Access 未覆盖它时，保存 Key 列表不会把该地址写入个人配置。
- 兼容单 Key 字段更新后，`apiKeys` 数组及其启停状态保持不变。
