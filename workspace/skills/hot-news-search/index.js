const axios = require('axios');

module.exports = {
  search_top_news: async (args) => {
    const apiKey = process.env.NEWS_API_KEY; // Ensure NEWS_API_KEY is set in the environment
    if (!apiKey) {
      throw new Error('NEWS_API_KEY environment variable not set.');
    }

    let url = `https://newsapi.org/v2/top-headlines?apiKey=${apiKey}&pageSize=5`;

    if (args.category) {
      url += `&category=${args.category}`;
    }

    if (args.country) {
      url += `&country=${args.country}`;
    }

    try {
      const response = await axios.get(url);
      if (response.data && response.data.articles) {
        const articles = response.data.articles.map(article => ({
          title: article.title,
          description: article.description,
          url: article.url,
          source: article.source.name
        }));

        if (args.keywords) {
            const keywordsArray = args.keywords.split(',').map(k => k.trim().toLowerCase());
            const filteredArticles = articles.filter(article => {
                const articleText = `${article.title} ${article.description}`.toLowerCase();
                return keywordsArray.every(keyword => articleText.includes(keyword));
            });
            return { result: filteredArticles };
        }

        return { result: articles };
      } else {
        return { result: 'No articles found.' };
      }
    } catch (error) {
      console.error('Error fetching news:', error);
      return { result: `Error fetching news: ${error.message}` };
    }
  }
};