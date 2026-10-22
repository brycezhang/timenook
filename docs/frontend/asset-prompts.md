# 素材生成记录

内置 imagegen 生成；未使用CLI/API密钥。生成原图存于Codex默认图片目录，项目内交付为经sips缩放与JPEG编码的独立素材。界面文字与按钮均由代码绘制。

| 项目素材 | 参考 | 用途 |
| --- | --- | --- |
| `miniprogram/assets/family.jpg` | `design/design-images/1.png` 左侧亲情照片 | 首页主视觉 |
| `miniprogram/assets/book.jpg` | `design/design-images/3.png` 左侧书籍 | 妈妈项目的成书效果 |
| `miniprogram/assets/father-book.jpg` | 新生成的book.jpg | 爸爸项目的对应成书效果 |

## Family prompt

Use case: photorealistic-natural. Standalone vertical editorial photo asset for Chinese family memoir mini program. Match the warm beige natural daylight photographic scene in reference image 1's LEFT phone: adult Chinese daughter about 32 with long dark hair in cream knit hugs smiling Chinese mother about 62 with short wavy dark hair touched with gray; mother holding a beautiful ivory linen hardcover book with subtle pressed flower botanical cover and only exact small Chinese title 妈妈的一生. Warm sunlit home, cream curtains, soft out of focus greenery. Upper 35 percent quiet pale cream wall/curtain for UI heading overlay; people in lower 65 percent, medium portrait from waist up. Bottom book fully visible. Real human hands, candid tender expressions, refined warm film photography. No phone frame, no app chrome, no buttons, no other words, no watermark. Portrait 3:4. Reference image is style and composition guide, create standalone photograph only.

## Book prompt

Use case: product-mockup. Standalone editorial product photograph for a Chinese family memoir mini program, based on reference image 3 left phone hero book. One exquisite warm ivory linen hardcover book standing on pale oak table, subtle spine visible, three-quarter perspective. Book cover has exact Chinese title 妈妈的一生 and small subtitle 爱与岁月的故事, tasteful thin brown serif lettering. Lower cover features natural photograph of a smiling Chinese woman about 62, short wavy dark hair touched gray, beige cardigan looking into sunlight with soft green meadow backdrop. Beautiful cream daylight, soft real shadows, blurred vase with small white flowers left behind book, cream curtain background. Restrained premium print photography. Large central book, entire cover visible, fills 80% height. No phone, no app UI, no buttons, no badges, no other words. Square composition.

## Father edit prompt

Edit this standalone book product photograph to create the matching father's book. Keep exact same composition, camera, book dimensions, warm ivory linen cover, pale oak table and cream background. Change the title only to exact Chinese 爸爸的一生, keep subtitle 爱与岁月的故事. Replace mother cover portrait with a warm smiling Chinese father age 65, short gray hair wearing light beige cardigan standing in the same soft green field. No other changes. No app UI.

图标使用lucide-static的线性图标；属于代码原生UI图标，不从效果图中裁切按钮或文字。语音页按照Figma N03的大按钮尺寸、问题层级及底部换题结构实现；已根据用户本轮确认将颜色统一为橄榄绿。
