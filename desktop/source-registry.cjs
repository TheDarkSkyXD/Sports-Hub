const sources = require('../lib/football/source-registry.json');

function browserCategories(sourceId) {
  return Object.fromEntries(sources.find(source=>source.id===sourceId).browserCategories.map(category=>[category.league,category]));
}

module.exports={browserCategories};
