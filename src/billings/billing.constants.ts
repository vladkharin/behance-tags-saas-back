export const PLANS_CONFIG = {
  // Робокасса (RUB)
  DAILY_FRESH: { price: 890, tags: 1500, label: 'Daily Fresh Plan' },
  PRO_STREAM: { price: 2250, tags: 6000, label: 'Pro Stream Plan' },

  // Лава (EUR/USD) - проверь цены в кабинете Lava и впиши сюда точно!
  DAILY_FRESH_LAVA: { price: 8.79, tags: 1500, label: 'Daily Fresh' },
  PRO_STREAM_LAVA: { price: 21.98, tags: 6000, label: 'Pro Stream' },
};

export const FUEL_CONFIG = {
  // Робокасса (RUB)
  '500': { price: 290, tags: 500, label: 'Fuel Pack 500' },
  '2000': { price: 690, tags: 2000, label: 'Fuel Pack 2000' },

  // Лава (RUB/EUR)
  '500_LAVA': { price: 50, tags: 500, label: 'Fuel Pack 500' }, // Ты поставил 50р для теста
  '2000_LAVA': { price: 690, tags: 2000, label: 'Fuel Pack 2000' },
};
