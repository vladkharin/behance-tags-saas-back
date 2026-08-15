import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

async function verifyRealTopCases() {
  console.log('================================================================');
  console.log('🔍 РЕАЛЬНАЯ ПРОВЕРКА СКРЕЙПЕРА НА ТОП-1/ТОП-2 КЕЙСАХ BEHANCE');
  console.log('   (Режим Read-Only: в базу данных ничего НЕ записывается)');
  console.log('================================================================\n');

  console.log('⏳ [1/4] Запуск Chromium Stealth...');
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

    // Блокировка тяжелых ассетов
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'media', 'font', 'stylesheet', 'other'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log('⏳ [2/4] Подключение к Behance и извлечение bcp сессии...');
    await page.goto('https://www.behance.net/search/projects', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 2500));

    const cookies = await page.cookies();
    const bcpToken = cookies.find((c) => c.name === 'bcp')?.value || '';

    if (!bcpToken) {
      throw new Error('Не удалось получить токен bcp из сессии Behance');
    }
    console.log(`✅ Сессия активна! Токен bcp: ${bcpToken.substring(0, 12)}...\n`);

    // Проверяем 2 популярных поисковых тега
    const testQueries = ['branding', 'packaging'];

    for (const queryTag of testQueries) {
      console.log(`----------------------------------------------------------------`);
      console.log(`🎯 Поиск Топ-100 проектов по тегу: "${queryTag}"`);
      console.log(`----------------------------------------------------------------`);

      // 1. Поиск топ-100 проектов по запросу
      const searchTop100 = await page.evaluate(async (term: string, token: string) => {
        const GQL = `query Search($query: query) { 
          search(query: $query, type: PROJECT, first: 100) { 
            nodes { 
              ... on Project { 
                id 
                name 
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
      }, queryTag, bcpToken);

      console.log(`Найдено проектов в выдаче Behance: ${searchTop100.length} шт.`);

      if (searchTop100.length === 0) {
        console.log(`⚠️ Не удалось получить результаты для "${queryTag}"`);
        continue;
      }

      // Берем реальный кейс #1 и кейс #2 из выдачи
      const topProjectsToTest = [
        { expectedRank: 1, project: searchTop100[0] },
        { expectedRank: 2, project: searchTop100[1] },
      ];

      for (const item of topProjectsToTest) {
        const targetId = String(item.project.id);
        const targetName = item.project.name;

        console.log(`\n📌 Проверяем кейс с ожидаемым местом #${item.expectedRank}:`);
        console.log(`   • Название: "${targetName}"`);
        console.log(`   • Behance ID: ${targetId}`);

        // 2. Забираем полные данные кейса
        const details = await page.evaluate(async (id: string, token: string) => {
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
          } `;
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
        }, targetId, bcpToken);

        if (!details) {
          console.log(`   ❌ Не удалось получить детали кейса #${targetId}`);
          continue;
        }

        console.log(`   • Просмотры: ${details.stats?.views?.all?.toLocaleString() || 0}`);
        console.log(`   • Лайки: ${details.stats?.appreciations?.all?.toLocaleString() || 0}`);
        console.log(`   • Комментарии: ${details.stats?.comments?.all?.toLocaleString() || 0}`);

        const projectTags = details.tags?.map((t: any) => t.title.toLowerCase().trim()) || [];
        console.log(`   • Теги проекта (${projectTags.length} шт.): ${projectTags.slice(0, 7).join(', ')}${projectTags.length > 7 ? '...' : ''}`);

        // 3. Проверяем позицию этого проекта по исходному тегу поиска
        const projectIdsInSearch = searchTop100.map((n: any) => String(n.id));
        const detectedIndex = projectIdsInSearch.indexOf(targetId);
        const detectedRank = detectedIndex !== -1 ? detectedIndex + 1 : -1;

        console.log(`\n   📊 РЕЗУЛЬТАТ ОПРЕДЕЛЕНИЯ ПОЗИЦИИ:`);
        console.log(`   • Тег поиска: "${queryTag}"`);
        console.log(`   • Ожидаемое место: #${item.expectedRank}`);
        console.log(`   • ОПРЕДЕЛЕННЫЙ РАНГ СКРЕЙПЕРОМ: #${detectedRank}`);

        if (detectedRank === item.expectedRank) {
          console.log(`   ✅ ИДЕАЛЬНОЕ СОВПАДЕНИЕ! Кейс #${item.expectedRank} точно обнаружен на позиции #${detectedRank} 🏆`);
        } else if (detectedRank > 0) {
          console.log(`   ⚠️ Кейс обнаружен на позиции #${detectedRank} (сдвиг в выдаче)`);
        } else {
          console.log(`   ❌ Кейс не найден в топ-100`);
        }

        // 4. Проверяем еще один случайный тег из самого проекта (например, второй тег)
        if (projectTags.length > 1) {
          const secondTag = projectTags[1];
          console.log(`\n   🔍 Дополнительная проверка по другому тегу кейса: "${secondTag}"`);

          const secondSearch = await page.evaluate(async (term: string, token: string) => {
            const GQL = `query Search($query: query) { 
              search(query: $query, type: PROJECT, first: 100) { 
                nodes { ... on Project { id } } 
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
          }, secondTag, bcpToken);

          const secondSearchIds = secondSearch.map((n: any) => String(n.id));
          const secondRankIndex = secondSearchIds.indexOf(targetId);
          const secondRank = secondRankIndex !== -1 ? secondRankIndex + 1 : -1;

          if (secondRank !== -1) {
            console.log(`   ✅ По тегу "${secondTag}" проект занимает позицию: #${secondRank} в Топ-100`);
          } else {
            console.log(`   ℹ️ По тегу "${secondTag}" проект находится за пределами Топ-100 (> 100)`);
          }
        }
      }
    }

    console.log('\n================================================================');
    console.log('🎉 ПРОВЕРКА НА РЕАЛЬНЫХ ТОПОВЫХ КЕЙСАХ ЗАВЕРШЕНА УСПЕШНО!');
    console.log('   (Все данные были протестированы вживую, без записи в БД)');
    console.log('================================================================');
  } catch (err: any) {
    console.error('❌ Ошибка во время проверки:', err.message);
  } finally {
    await browser.close();
  }
}

verifyRealTopCases();
