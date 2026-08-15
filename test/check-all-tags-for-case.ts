import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

async function checkAllTagsForCase() {
  const targetCaseId = '199017475';

  console.log('================================================================');
  console.log(`🚀 ПОЛНЫЙ АНАЛИЗ ВСЕХ ТЕГОВ КЕЙСА #${targetCaseId}`);
  console.log('   (Режим Read-Only: в базу данных ничего НЕ записывается)');
  console.log('================================================================\n');

  console.log('⏳ [1] Запуск Chromium Stealth...');
  const browser = await puppeteer.launch({
    headless: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--blink-settings=imagesEnabled=false',
      '--disable-remote-fonts',
      '--disable-background-networking',
      '--mute-audio',
      '--no-first-run',
    ],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);

    // Блокируем тяжелые ассеты для мгновенной скорости
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'media', 'font', 'stylesheet', 'other'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log('⏳ [2] Получение сессии Behance и токена bcp...');
    await page.goto('https://www.behance.net/search/projects', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 2500));

    const cookies = await page.cookies();
    const bcpToken = cookies.find((c) => c.name === 'bcp')?.value || '';

    if (!bcpToken) {
      throw new Error('bcp токен не найден в cookies');
    }
    console.log(`✅ Токен bcp успешно получен: ${bcpToken.substring(0, 12)}...\n`);

    console.log(`⏳ [3] Получаем список ВСЕХ тегов кейса #${targetCaseId} из Behance GraphQL...`);
    const projectDetails = await page.evaluate(async (id: string, token: string) => {
      const GQL = `query ProjectPage($projectId: ProjectId!) { 
        project(id: $projectId) { 
          id 
          name 
          tags { title } 
          stats { 
            appreciations { all } 
            views { all } 
            comments { all } 
          } 
        } 
      }`;
      const r = await fetch('https://www.behance.net/v3/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-adobe-app': 'behance',
          'x-bcp': token,
          'x-requested-with': 'XMLHttpRequest',
        },
        body: JSON.stringify({ query: GQL, variables: { projectId: id } }),
      });
      const json = await r.json();
      return json.data?.project;
    }, targetCaseId, bcpToken);

    if (!projectDetails) {
      throw new Error(`Не удалось загрузить данные по кейсу #${targetCaseId}`);
    }

    console.log(`📌 Проект: "${projectDetails.name}"`);
    console.log(`   👁️ Просмотры: ${projectDetails.stats?.views?.all?.toLocaleString()}`);
    console.log(`   ❤️ Лайки: ${projectDetails.stats?.appreciations?.all?.toLocaleString()}`);
    console.log(`   💬 Комментарии: ${projectDetails.stats?.comments?.all?.toLocaleString()}`);

    const rawTags: string[] = projectDetails.tags?.map((t: any) => t.title.trim()) || [];
    console.log(`\n📋 Найдено тегов у кейса: ${rawTags.length} шт.`);
    console.log(`   Список: ${rawTags.map(t => '#' + t).join(', ')}\n`);

    console.log('================================================================');
    console.log('🔍 ЗАПУСК ПРОВЕРКИ ПОЗИЦИЙ ПО КАЖДОМУ ТЕГУ (ТОП-100 ВЫДАЧИ)');
    console.log('================================================================\n');

    const results: Array<{ tag: string; rank: number | string; status: string }> = [];

    for (let i = 0; i < rawTags.length; i++) {
      const tag = rawTags[i];
      process.stdout.write(`[${i + 1}/${rawTags.length}] Проверка тега "${tag}"... `);

      const searchNodes = await page.evaluate(async (term: string, token: string) => {
        const GQL = `query Search($query: query) { 
          search(query: $query, type: PROJECT, first: 100) { 
            nodes { 
              ... on Project { 
                id 
              } 
            } 
          } 
        }`;
        const r = await fetch('https://www.behance.net/v3/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-adobe-app': 'behance',
            'x-bcp': token,
            'x-requested-with': 'XMLHttpRequest',
          },
          body: JSON.stringify({ query: GQL, variables: { query: term } }),
        });
        const json = await r.json();
        return json.data?.search?.nodes || [];
      }, tag, bcpToken);

      const ids = searchNodes.map((n: any) => String(n.id));
      const index = ids.indexOf(targetCaseId);
      const rank = index !== -1 ? index + 1 : -1;

      if (rank === 1) {
        console.log(`🥇 РАНГ: #1 (ПЕРВОЕ МЕСТО!)`);
        results.push({ tag, rank: `#1`, status: '🥇 Топ-1' });
      } else if (rank > 1 && rank <= 10) {
        console.log(`🔥 РАНГ: #${rank} (ТОП-10)`);
        results.push({ tag, rank: `#${rank}`, status: '🔥 Топ-10' });
      } else if (rank > 10 && rank <= 50) {
        console.log(`📈 РАНГ: #${rank} (ТОП-50)`);
        results.push({ tag, rank: `#${rank}`, status: '📈 Топ-50' });
      } else if (rank > 50 && rank <= 100) {
        console.log(`📊 РАНГ: #${rank} (ТОП-100)`);
        results.push({ tag, rank: `#${rank}`, status: '📊 Топ-100' });
      } else {
        console.log(`⚪ РАНГ: Вне Топ-100 (>100)`);
        results.push({ tag, rank: '> 100', status: '⚪ Вне Топ-100' });
      }

      // Небольшая пауза между запросами
      await new Promise((r) => setTimeout(r, 600));
    }

    console.log('\n================================================================');
    console.log('📊 ИТОГОВАЯ МАТРИЦА ПОЗИЦИЙ КЕЙСА:');
    console.log('================================================================');
    console.table(results);
    console.log('================================================================');
    console.log('🎉 ВСЕ ТЕГИ КЕЙСА УСПЕШНО ПРОВЕРЕНЫ В РЕАЛЬНОМ ВРЕМЕНИ!');
    console.log('================================================================');

  } catch (err: any) {
    console.error('❌ Ошибка:', err.message);
  } finally {
    await browser.close();
  }
}

checkAllTagsForCase();
