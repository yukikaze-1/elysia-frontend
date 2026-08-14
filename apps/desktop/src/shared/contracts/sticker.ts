// src/shared/contracts/sticker.ts
// 阶段 3 G4（spec §4.3/§4.6，D8）：内置表情包清单契约。
// P0-2：对齐 frontend_contract/rest.py StickerEntry{stickerId, src} / StickerListResponse{stickers}。
/** 表情包内置清单项（D-07 稳定 st_ ID） */
export interface StickerItem {
  stickerId: string       // ^st_[A-Za-z0-9-]+$
  src: string             // 静态资源路径（/static/stickers/{id}.png）；渲染统一经 cyrene://renderer/__cyrene-media/sticker/{stickerId}（D9）
}
/** 对齐 StickerListResponse{stickers:[...]} */
export interface StickerManifest { stickers: StickerItem[] }
