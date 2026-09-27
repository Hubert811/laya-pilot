# PR #1 选择性吸收范围

本分支从 `origin/main` 的 `5acef3f6731bc059add57b999f3c8835d9af7cf9` 创建。
对照 PR #1 的 `51abe5b0ebe21fc3376e64706e30286edcafac82`，逐项移植通用能力，没有合并 PR 提交历史。

## 纳入

- 保存、删除、确认后刷新前等待标准弹窗关闭及在途写请求结束；生成与回放共用。
- 每个逻辑步骤最多三次尝试，失败后报告原因与截图，继续独立用例；前置新增、修改失败的依赖用例明确标记阻断。
- 写点击发送后仅复查结果，不重复提交；不确定的结果不能记成成功。
- 标准 dialog、alertdialog 和明确的 dialog-content 标识识别，保留既有 AntD、Element 容器支持。
- 输入框的相邻 label、原生 required、原生有效性检查；label 不覆盖按钮自身文本。
- 禁用态校验的生成、回放、Excel 展示；同名控件有歧义时失败。
- 模型 JSON 格式要求，保留主版本决策阈值、默认超时及输出预算。
- Excel 非法控制字符清洗、回放尝试记录；Python 脚本路径改用 fileURLToPath。

## 不纳入

- 登录态缓存及 sessionStorage 自动注入、email-only 登录。
- 卡片列表与文本长度推断记录归属；继续要求表格记录。
- 用 fixed/inset-0/z-50 样式猜测弹窗、强制点击遮罩后的控件。
- 全局自动接受原生确认框、额外输出原始 API URL。
- 降低决策阈值、要求模型在证据不足时猜测、无条件延长 API 超时或增大输出预算。
- 固定项目测试密码、项目专用脚本、项目专用 gitignore 项。

`runner.mjs`、`lib/browser-provider.mjs`、`.gitignore` 保持主版本内容。
三次尝试的具体规则见 [retry-policy.md](retry-policy.md)。范围仅为生成和生成用例回放，不扩展旧版任意 Excel 执行器。

## 验证

- `node --test tests/*.test.mjs`
- 使用安装了 openpyxl 的 Python 执行 `python tests/test_workflow_excel.py`，验证生成、读回、结果写入及控制字符清洗。
- JavaScript 测试 49 项通过，Excel 往返测试 1 项通过；未进行真实后台浏览器端到端验证。
