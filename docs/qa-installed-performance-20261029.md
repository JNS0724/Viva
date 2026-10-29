# 当前性能分支的安装产物验收

2026-10-29，产品来源6c34450c936e167e9a3ce07c96def1baa8fb699e；0c75fbe仅更新快滚报告。本轮实际安装内容、六阶段回归、内置性能smoke及卸载清理均通过。展开全文的150ms预算和快速连滚专项仍独立开放。

后续 b86d619 又修复了展开跳转与后台准备状态导致全文折回预览，详见 [富内容阅读补测](qa-rich-reading-20261029.md)。本页安装结果只覆盖 6c34450；b86d619 已另行完成实际安装、六阶段及卸载验证，记录于 [2026-10-30 检查点](qa-performance-checkpoint-20261030.md)，未继承本页旧来源结果。

## 安装及内容一致性

正式包为本地构建的`Viva-0.4.0-beta.6-win-x64-setup.exe`，不是新发布版本。为保护原安装，复用正式win-unpacked的全部payload生成独立QA安装包装，仅改安装注册身份和复制的exe文件名，不改exe字节或app.asar。

- QA身份：VivaPerformanceQA20261029；GUID04ab2db1-d24a-40d3-a640-d131854b7ca6。
- QA安装器SHA256：9352017136cee3e4175a5f7ef5546168c8a84886b82b98dfdc8492a97db2db76。
- 原构建293个out文件与正式app.asar中的文件逐字节匹配。实际安装后144个payload文件与正式win-unpacked全部匹配，只映射exe文件名。
- exe SHA256：219aa10374bd0cd766b2dc26ed82b9e1157d228ec1df3259f4f50859c6ab11fc；app.asar SHA256：d1a0eedbb42fb61189a89bd2eb86cca640b7463ca6f2708c4dfd2e000070f9da。
- 临时安装根：`C:/Users/Administrator/AppData/Local/Temp/viva-performance-install-cRizOz`，应用安装在其`app`子目录，运行cwd同样位于仓库外。

直接从E盘构建目录执行的前两次尝试均exit0但目标缺失。复查旧成功记录后，只改变安装器执行位置：把同一哈希文件复制至新临时目录，参数仍为`/S /currentuser /D=<owned-temp>/app`，10:20:08–10:20:14Z实际安装成功。两份失败记录保留。该现象与执行位置相关，底层原因尚未确定，不能据此宣称正式安装器在所有路径均可靠。

## 已安装程序验证

从实际安装目录执行，使用独立SMOKE_OUT/profile，清除NODE_PATH、DSH_BIN和真实凭据。walkthrough/relaunch/timeline使用外部合成fixture；memory/resume实际运行包内DSH和应用插件、连接本地模型替身。没有用仓库node_modules补齐应用运行依赖。

| 阶段 | exit | 耗时 |
| --- | ---: | ---: |
| setup | 0 | 10.6s |
| walkthrough | 0 | 33.7s |
| relaunch | 0 | 47.7s |
| memory | 0 | 55.4s |
| resume | 0 | 4.7s |
| timeline | 0 | 14.0s |

六阶段10:22:22–10:25:08Z完成；包括当前任务卡节点保留回归、任务确认/提问与恢复、记忆、文件预览、历史及回顾路径。实际查看了任务浮层和窄窗截图，样本中核心按钮和输入区未被窗口边界裁切；这两张截图不替代完整原生窗口矩阵。

内置perf阶段另于10:27:07–10:27:23Z完成，exit0。普通千轮对话绘制200条，滚动p958.4ms/max10ms；回顾绘制最多200条，p958.5ms/max11ms，追加上文锚点漂移0.1px，读到末尾；远处搜索命中5ms。长文预览25ms，3887元素。该脚本Windows预算只记录数字，且没有点击展开全文；heapMb恒为10，不能证明真实堆稳定。没有把它当作完整长文性能通过。

## 卸载及限制

校验独立GUID、注册InstallLocation和实际临时目录，确认QA应用进程已退出后，只运行该目录的QA卸载器。10:32:32–10:32:34Z，exit0，应用exe及目标app目录已移除；前后快照确认QA注册项清除、既有两个Viva启动快捷方式哈希不变，未更改原Viva。

完整证据位于`E:/viva/qa-20261029-performance/package-validation-6c34450`：manifest、三次安装结果、六阶段逐项日志与进程回执、内置perf日志、卸载结果及前后注册表/快捷方式快照。独立包装不证明正式安装器升级、快捷方式和全部执行路径行为；未推送、合并或发布新版本。
