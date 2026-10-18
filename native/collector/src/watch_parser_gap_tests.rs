use crate::{detail_html::compatible_html_players, listing_html::parse_html, registry::SourceRegistry,
    resolver::{ResolveAction, ResolveFailure, Resolver}, types::{CandidateLocator, ListingOutcome, Observation}};
use serde_json::{Value, json};

fn registry() -> SourceRegistry {
    SourceRegistry::parse(include_str!("../../../lib/football/source-registry.json")).unwrap()
}

fn pages() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/watch-parser-gap-pages.json")).unwrap()
}

fn observation(source: &str, url: &str) -> Observation {
    serde_json::from_value(json!({"id":format!("{source}:fixture"),"sourceId":source,"url":url,
        "title":"Florida Panthers at Buffalo Sabres","teams":["Florida Panthers","Buffalo Sabres"],
        "league":"nhl","kickoff":1791824400000_i64,"rawTime":"2026-10-12T17:00:00Z",
        "observedAt":1791824400000_i64,"parserVersion":3})).unwrap()
}

#[test]
fn watch_gap_ten_published_empty_schedules_are_empty() {
    let registry=registry();
    let fixture=pages();
    let results:Vec<_>=fixture["cases"].as_array().unwrap().iter().map(|case|{
        let source=registry.get(case["sourceId"].as_str().unwrap()).unwrap();
        let result=parse_html(source,case["body"].as_str().unwrap(),1791824400000,&registry).unwrap();
        (source.id.clone(),result.outcome,result.observations.len())
    }).collect();
    assert_eq!(results, ["methstreams-f1","crackstreams-f1","buffstreams-f1","methstreams-vg-f1",
        "ihdstreams-cfb","ihdstreams-wnba","ihdstreams-ufc","ihdstreams-boxing","ihdstreams-wwe","streameasthd-boxing"]
        .map(|id|(id.to_string(),ListingOutcome::Empty,0)));
}

#[test]
fn watch_gap_missing_or_conflicting_empty_evidence_is_not_empty() {
    let registry=registry();
    let fixture=pages();
    for id in ["methstreams-f1","ihdstreams-cfb","streameasthd-boxing"] {
        let source=registry.get(id).unwrap();
        let result=parse_html(source,"<h1>Site maintenance</h1>",1791824400000,&registry).unwrap();
        assert_eq!(result.outcome,ListingOutcome::ParserChanged,"{id}");
    }
    let source=registry.get("ihdstreams-cfb").unwrap();
    let case=fixture["cases"].as_array().unwrap().iter().find(|case|case["sourceId"]==source.id).unwrap();
    for body in [case["body"].as_str().unwrap().replace("0 EVENTS","1 EVENTS"),
        case["body"].as_str().unwrap().replace("CFB STREAMS","NBA STREAMS")]{
        assert_eq!(parse_html(source,&body,1791824400000,&registry).unwrap().outcome,ListingOutcome::ParserChanged);
    }
}

#[test]
fn watch_gap_dudestream_published_empty_archive_is_not_parser_failure() {
    let registry=registry();
    let source=registry.get("dudestream-wwe").unwrap();
    let body=include_str!("../../../tests/fixtures/watch-dudestream-empty-category.html");
    let result=parse_html(source,body,1791824400000,&registry).unwrap();
    assert_eq!(result.outcome,ListingOutcome::Empty);
    assert_eq!(result.observations.len(),0);
    for changed in [body.replace("category-wwe","category-mma"),body.replace("Category: <span>WWE</span>","Category: <span>MMA</span>"),body.replace("mg-posts-sec-inner","unknown-post-area")] {
        assert_eq!(parse_html(source,&changed,1791824400000,&registry).unwrap().outcome,ListingOutcome::ParserChanged);
    }
}

#[test]
fn watch_gap_ihd_inline_player_is_extracted_once_without_executing_script() {
    let registry=registry();
    let row=observation("ihdstreams-nhl","https://ihdstreams.top/watch/florida-panthers-at-buffalo-sabres");
    let fixture=pages();
    let body=fixture["ihdPlayer"].as_str().unwrap();
    let players=compatible_html_players("nhl-401892485",&row,body,&registry).unwrap();
    assert_eq!(players.len(),1);
    assert!(matches!(&players[0].locator,CandidateLocator::EventPage{server_url,..}
        if server_url=="https://ihdstreams.top/embed/nhl/ch1.php"));
    assert_eq!(compatible_html_players("nhl-401892485",&row,&body.replace("L2VtYmVkL25obC9jaDEucGhw","aHR0cHM6Ly9leGFtcGxlLmNvbS9wbGF5"),&registry).unwrap().len(),0);
}

fn lsp_fixture() -> (Observation, Value, Vec<Value>) {
    let fixture:Value=serde_json::from_str(include_str!("../../../tests/fixtures/watch-livesportpro-reference.json")).unwrap();
    let event=fixture["event"].clone();
    let mut row=observation("livesportpro","https://api.kultsport.com/api/matches/all#buffalo-sabres-vs-florida-panthers-2591571");
    row.title=event["title"].as_str().unwrap().to_string();
    row.kickoff=event["date"].as_i64();
    row.teams=Some([event["teams"]["home"]["name"].as_str().unwrap().to_string(),event["teams"]["away"]["name"].as_str().unwrap().to_string()]);
    (row,event,fixture["streams"].as_array().unwrap().clone())
}

#[test]
fn watch_gap_lsp_streamcenter_contract_and_siblings_are_resolved() {
    let (row,event,streams)=lsp_fixture();
    let (mut resolver,action)=Resolver::begin("nhl-401892485",&row,&event.to_string());
    assert!(matches!(action,ResolveAction::ReadBatch{abort_siblings_on_failure:false,..}));
    let ResolveAction::Done{players}=resolver.advance(streams.iter().map(|body|Ok(body.to_string())).collect()) else {panic!("valid independent sources must resolve")};
    assert_eq!(players.len(),6);
    assert_eq!(players.iter().filter(|player|matches!(player.locator,CandidateLocator::CatalogStream{..})).count(),5);
    assert!(players.iter().any(|player|matches!(&player.locator,CandidateLocator::Streamcenter{event_id,link_id,league:Some(crate::types::League::Nhl)}
        if event_id=="401892485"&&link_id=="4f6fb9e5-00d4-40e9-b173-3994e3b88739")));
}

#[test]
fn watch_gap_lsp_failed_reference_keeps_verified_siblings() {
    let (row,event,streams)=lsp_fixture();
    let (mut resolver,_)=Resolver::begin("nhl-401892485",&row,&event.to_string());
    let mut responses:Vec<_>=streams.iter().map(|body|Ok(body.to_string())).collect();
    responses[1]=Err(ResolveFailure{name:"Error".into(),message:"http-503".into(),read_error_id:Some(2)});
    let ResolveAction::Done{players}=resolver.advance(responses) else {panic!("one failed reference cannot discard compatible siblings")};
    assert_eq!(players.len(),5);
    let (mut resolver,_)=Resolver::begin("nhl-401892485",&row,&event.to_string());
    let mut invalid=streams;
    invalid[1][0]["id"]="not-a-uuid".into();
    let ResolveAction::Done{players}=resolver.advance(invalid.iter().map(|body|Ok(body.to_string())).collect()) else {panic!("invalid source must be isolated")};
    assert_eq!(players.len(),5);
}

#[test]
fn watch_gap_lsp_wrong_event_is_rejected_and_all_failed_stays_failed() {
    let (row,mut event,streams)=lsp_fixture();
    event["sources"]=json!([event["sources"][1].clone()]);
    let (mut resolver,_)=Resolver::begin("nhl-401892486",&row,&event.to_string());
    match resolver.advance(vec![Ok(streams[1].to_string())]) {
        ResolveAction::Failed{..}=>{},
        ResolveAction::Done{players}=>assert!(players.is_empty()),
        _=>panic!("wrong event must not resolve a Streamcenter candidate"),
    }
    let (mut resolver,_)=Resolver::begin("nhl-401892485",&row,&event.to_string());
    assert!(matches!(resolver.advance(vec![Err(ResolveFailure{name:"Error".into(),message:"http-503".into(),read_error_id:Some(1)})]),ResolveAction::Failed{error}if error.message=="http-503"));
}
