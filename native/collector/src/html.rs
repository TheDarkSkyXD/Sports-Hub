use scraper::{ElementRef, Html, Selector};

pub struct HtmlDoc(Html);

impl HtmlDoc {
    pub fn parse(body: &str) -> Self {
        Self(Html::parse_document(body))
    }

    pub fn select<'a>(&'a self, selector: &str) -> Vec<ElementRef<'a>> {
        let Ok(selector) = Selector::parse(selector) else {
            return Vec::new();
        };
        self.0.select(&selector).collect()
    }
}

pub fn select<'a>(element: ElementRef<'a>, selector: &str) -> Vec<ElementRef<'a>> {
    let Ok(selector) = Selector::parse(selector) else {
        return Vec::new();
    };
    element.select(&selector).collect()
}

pub fn attr<'a>(element: ElementRef<'a>, name: &str) -> Option<&'a str> {
    element.value().attr(name)
}

pub fn text(element: ElementRef<'_>) -> String {
    element.text().collect::<String>()
}

pub fn text_without_excluded(element: ElementRef<'_>) -> String {
    let mut result = String::new();
    for node in element.descendants() {
        if let scraper::Node::Text(value) = node.value() {
            let excluded = node.ancestors().any(|parent| {
                matches!(parent.value(), scraper::Node::Element(tag) if matches!(tag.name(), "script" | "style" | "noscript"))
            });
            if !excluded {
                result.push_str(value);
            }
        }
    }
    result
}

pub fn clean_text(element: ElementRef<'_>) -> String {
    text_without_excluded(element)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn inner_html(element: ElementRef<'_>) -> String {
    element.inner_html()
}

pub fn closest<'a>(element: ElementRef<'a>, selector: &str) -> Option<ElementRef<'a>> {
    let selector = Selector::parse(selector).ok()?;
    let mut current = Some(element);
    while let Some(candidate) = current {
        if selector.matches(&candidate) {
            return Some(candidate);
        }
        current = candidate.parent().and_then(ElementRef::wrap);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_ignores_non_content_elements() {
        let doc = HtmlDoc::parse(
            "<main><div class='card'>A<script>bad</script><style>bad</style><noscript>bad</noscript><span>B</span></div></main>",
        );
        let card = doc.select(".card")[0];
        assert_eq!(text_without_excluded(card), "AB");
        assert_eq!(clean_text(card), "AB");
        assert_eq!(attr(card, "class"), Some("card"));
        assert_eq!(
            closest(doc.select("span")[0], ".card").and_then(|found| attr(found, "class")),
            Some("card")
        );
    }
}
