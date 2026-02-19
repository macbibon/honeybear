// supabase/functions/_shared/shop.ts

export type ItemType = "hat" | "accessory" | "background" | "color";

export const SKINS_CATALOG: Record<ItemType, Array<{ id: string; price_amber: number; label: string; seasonal?: boolean; free?: boolean }>> = {
  hat: [
    { id: "cap", label: "Cap", price_amber: 30 },
    { id: "crown", label: "Crown", price_amber: 100 },
    { id: "santa", label: "Santa", price_amber: 150, seasonal: true },
  ],
  accessory: [
    { id: "scarf", label: "Scarf", price_amber: 30 },
    { id: "glasses", label: "Glasses", price_amber: 50 },
    { id: "backpack", label: "Backpack", price_amber: 80 },
  ],
  background: [
    { id: "forest", label: "Forest", price_amber: 0, free: true },
    { id: "mountains", label: "Mountains", price_amber: 40 },
    { id: "winter", label: "Winter", price_amber: 60 },
    { id: "sakura", label: "Sakura", price_amber: 100 },
  ],
  color: [
    { id: "brown", label: "Brown", price_amber: 0, free: true },
    { id: "white", label: "White", price_amber: 200 },
    { id: "panda", label: "Panda", price_amber: 300 },
  ],
};

export const AMBER_PACKS: Array<{ product_id: string; amber: number; stars: number }> = [
  { product_id: "amber_50", amber: 50, stars: 49 },
  { product_id: "amber_120", amber: 120, stars: 99 },
  { product_id: "amber_300", amber: 300, stars: 199 },
];

export function findSkin(item_type: ItemType, item_id: string) {
  const items = SKINS_CATALOG[item_type] || [];
  return items.find((x) => x.id === item_id) || null;
}

export function findPack(product_id: string) {
  return AMBER_PACKS.find((p) => p.product_id === product_id) || null;
}
