import { COLLEGE_TEAM_CATALOG } from '../../football/domain/college-teams.generated.ts';

type ExpectedMatchup={league:'nfl'|'ncaaf';teams:readonly [string,string]};

const normalizedName=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/\band\b/g,'&').replace(/[^a-z0-9]/g,'');

const collegeOwners=new Map<string,Set<string>>();
for(const team of COLLEGE_TEAM_CATALOG)for(const alias of team.aliases){
  const key=normalizedName(alias);
  if(!key)continue;
  const owners=collegeOwners.get(key)||new Set<string>();
  owners.add(team.id);
  collegeOwners.set(key,owners);
}

function uniqueOwner(name:string):string|null {
  const owners=collegeOwners.get(normalizedName(name));
  return owners?.size===1?[...owners][0]:null;
}

function publishedOwner(name:string,edge:'start'|'end'):string|null {
  const value=normalizedName(name);
  let longest=0;
  const owners=new Set<string>();
  for(const [alias,candidates] of collegeOwners){
    if(alias.length<3||alias.length<5&&value!==alias||
      !(edge==='start'?value.startsWith(alias):value.endsWith(alias)))continue;
    if(alias.length>longest){longest=alias.length;owners.clear();}
    if(alias.length===longest)for(const owner of candidates)owners.add(owner);
  }
  return owners.size===1?[...owners][0]:null;
}

export function conflictingPublishedFootballMatchup(expected:ExpectedMatchup,title:string):boolean {
  if(expected.league!=='ncaaf')return false;
  const parts=title.split(/\s+(?:vs\.?|versus|at)\s+/i);
  if(parts.length!==2)return false;
  const expectedOwners=expected.teams.map(uniqueOwner);
  if(!expectedOwners[0]||!expectedOwners[1]||expectedOwners[0]===expectedOwners[1])return false;
  const published=[publishedOwner(parts[0],'end'),publishedOwner(parts[1],'start')];
  if(!published[0]||!published[1]||published[0]===published[1])return false;
  return !(published[0]===expectedOwners[0]&&published[1]===expectedOwners[1]||
    published[0]===expectedOwners[1]&&published[1]===expectedOwners[0]);
}
