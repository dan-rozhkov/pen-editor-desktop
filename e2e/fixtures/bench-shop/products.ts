// Deterministic product catalog for the bench-shop fixture (e2e/bench-browse.spec.ts
// and e2e/browser-shop-fixture.spec.ts). Hardcoded, not procedurally generated, so
// the exact set of products matching any search/filter/sort combination is knowable
// ahead of time and can be asserted on directly.
//
// The "headphones" slice is deliberately built so that searching "headphones", then
// filtering to brand "AudioNova" + wireless + price <= 100, then sorting by rating
// descending has one unambiguous top result — see the comment above HEADPHONES below.

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: string;
  price: number;
  wireless: boolean;
  rating: number;
  description: string;
}

// Qualifies for brand=AudioNova + wireless + price<=100: ids hp-01, hp-02, hp-09, hp-10.
// Sorted by rating desc: hp-02 (4.7) > hp-10 (4.6) > hp-01 (4.2) > hp-09 (3.5).
// So the expected top result of the bench task's filter+sort is hp-02, "AudioNova Studio Wireless".
const HEADPHONES: Product[] = [
  {
    id: "hp-01",
    name: "AudioNova Buds Mini",
    brand: "AudioNova",
    category: "headphones",
    price: 49.99,
    wireless: true,
    rating: 4.2,
    description: "Compact true-wireless headphones with a 20-hour case.",
  },
  {
    id: "hp-02",
    name: "AudioNova Studio Wireless",
    brand: "AudioNova",
    category: "headphones",
    price: 89.99,
    wireless: true,
    rating: 4.7,
    description: "Over-ear wireless headphones tuned for studio monitoring.",
  },
  {
    id: "hp-03",
    name: "AudioNova Wired Classic",
    brand: "AudioNova",
    category: "headphones",
    price: 39.99,
    wireless: false,
    rating: 4.0,
    description: "A corded classic. Not wireless — should be excluded by the Wireless filter.",
  },
  {
    id: "hp-04",
    name: "AudioNova Pro Wireless",
    brand: "AudioNova",
    category: "headphones",
    price: 129.99,
    wireless: true,
    rating: 4.9,
    description: "Flagship wireless headphones. Over the $100 price cap on purpose.",
  },
  {
    id: "hp-05",
    name: "SoundPeak Wireless Headphones",
    brand: "SoundPeak",
    category: "headphones",
    price: 59.99,
    wireless: true,
    rating: 4.5,
    description: "A different brand — should be excluded by a brand=AudioNova filter.",
  },
  {
    id: "hp-06",
    name: "EchoWave Over-Ear Headphones",
    brand: "EchoWave",
    category: "headphones",
    price: 75.0,
    wireless: true,
    rating: 4.1,
    description: "Comfortable over-ear headphones for everyday listening.",
  },
  {
    id: "hp-07",
    name: "BassLine Bluetooth Headphones",
    brand: "BassLine",
    category: "headphones",
    price: 95.0,
    wireless: true,
    rating: 3.9,
    description: "Bass-forward Bluetooth headphones.",
  },
  {
    id: "hp-08",
    name: "ClearTone Studio Headphones",
    brand: "ClearTone",
    category: "headphones",
    price: 65.0,
    wireless: false,
    rating: 4.3,
    description: "Wired studio headphones with a flat frequency response.",
  },
  {
    id: "hp-09",
    name: "AudioNova Kids Headphones",
    brand: "AudioNova",
    category: "headphones",
    price: 25.0,
    wireless: true,
    rating: 3.5,
    description: "Volume-limited wireless headphones for children.",
  },
  {
    id: "hp-10",
    name: "AudioNova Sport Earbuds",
    brand: "AudioNova",
    category: "headphones",
    price: 69.99,
    wireless: true,
    rating: 4.6,
    description: "Sweat-resistant wireless earbuds for workouts.",
  },
];

const OTHER: Product[] = [
  { id: "wa-01", name: "ChronoFit Smartwatch", brand: "ChronoFit", category: "watches", price: 119.0, wireless: true, rating: 4.4, description: "Fitness tracking smartwatch with heart-rate sensor." },
  { id: "wa-02", name: "ChronoFit Lite Watch", brand: "ChronoFit", category: "watches", price: 59.0, wireless: true, rating: 4.0, description: "Entry-level fitness watch." },
  { id: "wa-03", name: "Heritage Analog Watch", brand: "Heritage", category: "watches", price: 149.0, wireless: false, rating: 4.6, description: "Classic analog watch with a leather strap." },
  { id: "bg-01", name: "Voyage Weekender Bag", brand: "Voyage", category: "bags", price: 89.0, wireless: false, rating: 4.3, description: "Canvas weekender bag." },
  { id: "bg-02", name: "Voyage Daypack", brand: "Voyage", category: "bags", price: 49.0, wireless: false, rating: 4.1, description: "Lightweight daily backpack." },
  { id: "bg-03", name: "Urban Sling Bag", brand: "Urban", category: "bags", price: 35.0, wireless: false, rating: 3.8, description: "Compact crossbody sling bag." },
  { id: "sh-01", name: "TrailRunner Sneakers", brand: "TrailRunner", category: "shoes", price: 99.0, wireless: false, rating: 4.5, description: "Cushioned trail running shoes." },
  { id: "sh-02", name: "TrailRunner Trail Mid", brand: "TrailRunner", category: "shoes", price: 129.0, wireless: false, rating: 4.2, description: "Mid-cut hiking shoes." },
  { id: "sh-03", name: "Everyday Canvas Sneakers", brand: "Everyday", category: "shoes", price: 45.0, wireless: false, rating: 4.0, description: "Simple canvas sneakers." },
  { id: "el-01", name: "PixelBeam Desk Lamp", brand: "PixelBeam", category: "electronics", price: 39.0, wireless: false, rating: 4.1, description: "USB-C desk lamp with adjustable warmth." },
  { id: "el-02", name: "PixelBeam Wireless Charger", brand: "PixelBeam", category: "electronics", price: 29.0, wireless: true, rating: 4.3, description: "15W wireless charging pad." },
  { id: "el-03", name: "KeyForge Mechanical Keyboard", brand: "KeyForge", category: "electronics", price: 109.0, wireless: true, rating: 4.6, description: "Wireless mechanical keyboard, hot-swappable switches." },
  { id: "el-04", name: "KeyForge Wired Keyboard", brand: "KeyForge", category: "electronics", price: 59.0, wireless: false, rating: 4.2, description: "Budget wired mechanical keyboard." },
  { id: "el-05", name: "GlassView Monitor Stand", brand: "GlassView", category: "electronics", price: 44.0, wireless: false, rating: 4.0, description: "Tempered glass monitor riser." },
  { id: "hm-01", name: "Aromatica Candle Set", brand: "Aromatica", category: "home", price: 25.0, wireless: false, rating: 4.4, description: "Set of three soy candles." },
  { id: "hm-02", name: "Aromatica Diffuser", brand: "Aromatica", category: "home", price: 34.0, wireless: false, rating: 4.1, description: "Ultrasonic essential oil diffuser." },
  { id: "hm-03", name: "CozyKnit Throw Blanket", brand: "CozyKnit", category: "home", price: 42.0, wireless: false, rating: 4.5, description: "Chunky knit throw blanket." },
  { id: "ap-01", name: "Meridian Rain Jacket", brand: "Meridian", category: "apparel", price: 79.0, wireless: false, rating: 4.3, description: "Packable waterproof rain jacket." },
  { id: "ap-02", name: "Meridian Fleece Vest", brand: "Meridian", category: "apparel", price: 55.0, wireless: false, rating: 4.0, description: "Lightweight fleece vest." },
  { id: "ap-03", name: "Basics Crew Tee", brand: "Basics", category: "apparel", price: 19.0, wireless: false, rating: 3.9, description: "Cotton crew-neck t-shirt." },
];

export const PRODUCTS: Product[] = [...HEADPHONES, ...OTHER];

export const CATEGORIES = Array.from(new Set(PRODUCTS.map((p) => p.category))).sort();

export function findProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function searchProducts(query: string): Product[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return PRODUCTS.filter(
    (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.category.toLowerCase().includes(q),
  );
}
