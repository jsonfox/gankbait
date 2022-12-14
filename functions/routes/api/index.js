const router = require('express').Router();
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../../utils/auth');
const { parseMatchData, parseTimelineData } = require('../../utils/parser');
const { User } = require('../../models');
const rgapiAxiosConfig = { headers: { 'X-Riot-Token': process.env.RIOT_API_KEY } };
const apiLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
})

router.put('/summoner', authenticateToken, async ({ userData, body }, res) => {
  const { id } = userData;
  const { name, region, queue } = body;

  try {
    const requestURL = `https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-name/${name}`;
    const response = await axios.get(requestURL, rgapiAxiosConfig);
    if (response.status === 404) return res.status(404);
    const { data } = response;
    await User.updateOne({ _id: id }, {
      summonerName: data.name,
      summonerId: data.id,
      summonerPuuid: data.puuid,
      region,
      queue
    });
    return res.status(200).json({ name: data.name });
  } catch (err) {
    console.error(err.stack || err.response.data || err);
    if (err.response?.status === 404) return res.sendStatus(204);
    return res.sendStatus(500);
  }
});

router.get('/matches', [authenticateToken, apiLimiter], async ({ userData }, res) => {
  const { id } = userData;
  const regionRoute = (code) =>
    ['na', 'lan', 'las', 'br'].includes(code)
      ? 'americas'
      : ['eune', 'euw', 'tr', 'ru'].includes(code)
        ? 'europe'
        : ['kr', 'jp'].includes(code)
          ? 'asia'
          : 'sea'

  const dbUser = await User.findById(id);
  const clearStats = async () => await User.updateOne({ _id: id }, { "$REMOVE": ["stats"] });
  try {
    const { summonerId, summonerName, summonerPuuid, region, queue } = dbUser;
    console.log('Analyzing data for', summonerName);
    const apiURL = `https://${regionRoute(region)}.api.riotgames.com/lol/match/v5/matches/`

    const matchIds = await axios.get(`${apiURL}by-puuid/${summonerPuuid}/ids/?${queue === 'ranked' ? 'type=ranked' : 'queue=400'}`, rgapiAxiosConfig);
    if (!matchIds.data.length) {
      await clearStats();
      return res.sendStatus(204);
    }

    const matchTeams = [];
    const matchResults = [];

    await Promise.all(matchIds.data.map(async (id) => {
      const currMatch = await axios.get(apiURL + id, rgapiAxiosConfig);
      const currTeams = parseMatchData(currMatch.data, summonerId);
      matchTeams.push(currTeams);
      const currTimeline = await axios.get(apiURL + id + '/timeline', rgapiAxiosConfig);
      const currResults = parseTimelineData(currTimeline.data, currTeams);
      matchResults.push(currResults);
    }));

    const laneResults = matchResults.filter(({ jungle }) => !jungle);
    const jungleResults = matchResults.filter(({ jungle }) => jungle);

    const stats = {
      summonerName,
      lane: {
        games: laneResults.length,
        killsFromGanks: laneResults.reduce((acc, s) => acc + s.killsFromGanks, 0),
        deathsFromGanks: laneResults.reduce((acc, s) => acc + s.deathsFromGanks, 0)
      },
      jungle: {
        games: jungleResults.length,
        killsFromGanks: jungleResults.reduce((acc, s) => acc + s.killsFromGanks, 0),
        deathsFromGanks: jungleResults.reduce((acc, s) => acc + s.deathsFromGanks, 0)
      }
    }

    console.log('Caching results for', summonerName);
    await User.updateOne({ _id: id }, { stats });
    return res.sendStatus(200);
  } catch (err) {
    console.error(err.stack || err.response.data || err);
    if (dbUser.stats && dbUser.stats.summonerName !== dbUser.summonerName) await clearStats();
    const message = err.response?.status === 429 ?
      'The API is currently handling too many requests and is being rate limited by the Riot API, please wait a 30 seconds before trying another request' :
      'The server encountered an error processing the request or the request timed out.'
    return res.status(500).json({ message });
  }
});

module.exports = router;