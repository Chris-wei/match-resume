# 分享图源文件

`miniprogram/images/share-card.jpg`（发给朋友，5:4）与 `share-timeline.jpg`（朋友圈，1:1）由这里的 HTML 渲染：

```bash
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$C" --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=500,400 --screenshot=card.png share-card.html
"$C" --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=400,400 --screenshot=timeline.png share-timeline.html
sips -s format jpeg -s formatOptions 85 card.png --out ../../miniprogram/images/share-card.jpg
sips -s format jpeg -s formatOptions 85 timeline.png --out ../../miniprogram/images/share-timeline.jpg
```
