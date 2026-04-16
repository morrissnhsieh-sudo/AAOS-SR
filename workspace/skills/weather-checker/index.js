const https = require('https');

module.exports = {
  get_weather: async (args) => {
    const city = args.city;
    const apiKey = args.api_key;
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`;

    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          try {
            const weatherData = JSON.parse(data);
            if (weatherData.cod === 200) {
              const temperature = weatherData.main.temp;
              const description = weatherData.weather[0].description;
              const humidity = weatherData.main.humidity;
              const windSpeed = weatherData.wind.speed;

              resolve({ 
                result: `The weather in ${city} is ${description} with a temperature of ${temperature}°C. Humidity is ${humidity}% and wind speed is ${windSpeed} m/s.`
              });
            } else {
              reject({ result: `Error: ${weatherData.message}` });
            }
          } catch (error) {
            reject({ result: `Error parsing weather data: ${error}` });
          }
        });
      }).on('error', (error) => {
        reject({ result: `Error fetching weather data: ${error}` });
      });
    });
  }
};