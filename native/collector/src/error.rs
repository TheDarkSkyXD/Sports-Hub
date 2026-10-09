use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CollectorError {
    InvalidRegistry(String),
    InvalidInput(String),
    InvalidState(String),
    Aborted,
    NotImplemented(&'static str),
}

impl fmt::Display for CollectorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRegistry(message)
            | Self::InvalidInput(message)
            | Self::InvalidState(message) => formatter.write_str(message),
            Self::Aborted => formatter.write_str("aborted"),
            Self::NotImplemented(method) => write!(formatter, "{method} is not implemented"),
        }
    }
}

impl std::error::Error for CollectorError {}

impl From<CollectorError> for napi::Error {
    fn from(error: CollectorError) -> Self {
        napi::Error::from_reason(error.to_string())
    }
}
