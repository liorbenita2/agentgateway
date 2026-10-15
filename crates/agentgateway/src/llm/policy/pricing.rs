use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;

use crate::cel::{Executor, Expression, ExtensionOrDirect, LLMContext, RequestSnapshot, Value};
use crate::llm::catalog::{Breakdown, CostBreakdown};
use crate::proxy::dtrace;
use crate::*;

const TRACE_POLICY_KIND: &str = "llm_pricing";

#[apply(schema!)]
pub struct PricingRule {
	/// Selects the requests this rule prices; absent means always. The first matching rule applies.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub condition: Option<Arc<Expression>>,
	/// CEL expressions returning the USD cost of each component. Unset components keep the
	/// catalog cost; the total is always the sum of the components.
	pub cost: PricingCost,
}

#[apply(schema!)]
#[derive(Default)]
pub struct PricingCost {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub input: Option<Arc<Expression>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub output: Option<Arc<Expression>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cache_read: Option<Arc<Expression>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cache_write: Option<Arc<Expression>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cache_write_1h: Option<Arc<Expression>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub reasoning: Option<Arc<Expression>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub input_audio: Option<Arc<Expression>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub output_audio: Option<Arc<Expression>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub pages: Option<Arc<Expression>>,
}

impl PricingCost {
	fn expressions(&self) -> [(&'static str, Option<&Expression>); 9] {
		[
			("input", self.input.as_deref()),
			("output", self.output.as_deref()),
			("cacheRead", self.cache_read.as_deref()),
			("cacheWrite", self.cache_write.as_deref()),
			("cacheWrite1h", self.cache_write_1h.as_deref()),
			("reasoning", self.reasoning.as_deref()),
			("inputAudio", self.input_audio.as_deref()),
			("outputAudio", self.output_audio.as_deref()),
			("pages", self.pages.as_deref()),
		]
	}
}

pub(super) fn expressions(rules: &[PricingRule]) -> impl Iterator<Item = &Expression> {
	rules.iter().flat_map(|r| {
		r.condition
			.as_deref()
			.into_iter()
			.chain(r.cost.expressions().into_iter().filter_map(|(_, e)| e))
	})
}

/// Reprices `llm.cost` with the first rule whose condition matches.
pub fn apply(rules: &[PricingRule], req: Option<&RequestSnapshot>, llm: &mut LLMContext) {
	if let Some(cost) = price(rules, req, llm) {
		llm.cost = Some(cost);
	}
}

fn price(
	rules: &[PricingRule],
	req: Option<&RequestSnapshot>,
	llm: &LLMContext,
) -> Option<Breakdown> {
	let mut exec = Executor::new_request_snapshot(req);
	exec.llm = ExtensionOrDirect::Direct(Some(llm));
	let (index, rule) = rules
		.iter()
		.enumerate()
		.find(|(_, r)| r.condition.as_ref().is_none_or(|c| exec.eval_bool(c)))?;

	let mut cost = llm.cost.clone().unwrap_or_default();
	let Breakdown {
		input,
		cache_read,
		cache_write,
		cache_write_1h,
		output,
		reasoning,
		input_audio,
		output_audio,
		pages,
	} = &mut cost;
	let slots = [
		input,
		output,
		cache_read,
		cache_write,
		cache_write_1h,
		reasoning,
		input_audio,
		output_audio,
		pages,
	];
	for ((component, expr), slot) in rule.cost.expressions().into_iter().zip(slots) {
		let Some(expr) = expr else { continue };
		match exec.eval(expr).map_err(|e| e.to_string()).and_then(usd) {
			Ok(v) => *slot = v,
			// A broken expression keeps the catalog price rather than dropping the component.
			Err(error) => dtrace::pol_event!(
				TRACE_POLICY_KIND,
				dtrace::Severity::Warn,
				details = serde_json::json!({
					"rule": index,
					"component": component,
					"error": error,
				}),
			),
		}
	}
	dtrace::pol_event!(
		TRACE_POLICY_KIND,
		dtrace::Severity::Info,
		details = serde_json::json!({
			"rule": index,
			"cost": CostBreakdown::from(&cost),
		}),
	);
	Some(cost)
}

fn usd(v: Value) -> Result<Decimal, String> {
	let f = match v {
		Value::Float(f) => f,
		Value::Int(i) => i as f64,
		Value::UInt(u) => u as f64,
		other => return Err(format!("expected a number, got {other:?}")),
	};
	if !f.is_finite() || f < 0.0 {
		return Err(format!("cost must be a non-negative number, got {f}"));
	}
	Decimal::from_f64(f).ok_or_else(|| format!("cost {f} is out of range"))
}

#[cfg(test)]
mod tests {
	use std::str::FromStr;

	use serde_json::json;

	use super::*;
	use crate::llm::catalog::ModelCatalog;
	use crate::llm::{CacheTokenConvention, InputFormat, LLMInfo, LLMRequest, LLMResponse};
	use crate::store::HasExpressions;

	const CATALOG: &str =
		r#"{"providers":{"openai":{"models":{"gpt":{"rates":{"input":"2","output":"8"}}}}}}"#;

	fn dec(s: &str) -> Decimal {
		Decimal::from_str(s).unwrap()
	}

	// 1M input and 0.5M output tokens: $2 input + $4 output in the catalog.
	fn llm(model: &str) -> LLMContext {
		let catalog = ModelCatalog::from_json(CATALOG);
		let request = LLMRequest {
			input_tokens: None,
			input_format: InputFormat::Completions,
			cache_convention: CacheTokenConvention::InputIncludesCache,
			request_model: model.into(),
			provider: "openai".into(),
			streaming: false,
			params: Default::default(),
			prompt: None,
			provider_state: None,
		};
		let response = LLMResponse {
			input_tokens: Some(1_000_000),
			output_tokens: Some(500_000),
			..Default::default()
		};
		LLMContext::from_llm_info(LLMInfo::new(request, response), Some(&catalog))
	}

	fn rules(v: serde_json::Value) -> Vec<PricingRule> {
		serde_json::from_value(v).unwrap()
	}

	fn priced(model: &str, v: serde_json::Value) -> Breakdown {
		llm(model)
			.with_pricing(Some(&rules(v)), None)
			.cost
			.expect("priced")
	}

	#[test]
	fn overrides_matched_components_and_keeps_the_rest() {
		let cost = priced(
			"gpt",
			json!([{
				"condition": "llm.provider == 'openai'",
				"cost": {"input": "llm.cost.input * 0.5"},
			}]),
		);
		assert_eq!(cost.input, dec("1"));
		assert_eq!(cost.output, dec("4"));
		assert_eq!(cost.total(), dec("5"));
	}

	#[test]
	fn no_match_leaves_cost_unchanged() {
		let cost = priced(
			"gpt",
			json!([{"condition": "llm.provider == 'anthropic'", "cost": {"input": "0"}}]),
		);
		assert_eq!(Some(cost), llm("gpt").cost);
	}

	#[test]
	fn first_match_wins() {
		let cost = priced(
			"gpt",
			json!([
				{"condition": "llm.requestModel == 'other'", "cost": {"output": "3"}},
				{"condition": "llm.requestModel == 'gpt'", "cost": {"output": "1"}},
				{"cost": {"output": "2"}},
			]),
		);
		assert_eq!(cost.output, dec("1"));
		assert_eq!(cost.total(), dec("3"));
	}

	#[test]
	fn prices_a_model_missing_from_the_catalog() {
		assert_eq!(llm("self-hosted").cost, None);
		let cost = priced(
			"self-hosted",
			json!([{"cost": {
				"input": "double(llm.inputTokens) / 1000000.0 * 0.25",
				"output": "0",
			}}]),
		);
		assert_eq!(
			cost,
			Breakdown {
				input: dec("0.25"),
				..Default::default()
			}
		);
		assert_eq!(cost.total(), dec("0.25"));
	}

	#[test]
	fn invalid_component_keeps_catalog_value() {
		let cost = priced(
			"gpt",
			json!([{"cost": {"input": "llm.cost.input * -1.0", "output": "'free'"}}]),
		);
		assert_eq!(cost.input, dec("2"));
		assert_eq!(cost.output, dec("4"));
	}

	#[test]
	fn condition_reads_the_request() {
		let mut req = ::http::Request::builder()
			.body(crate::http::Body::empty())
			.unwrap();
		req.extensions_mut().insert(crate::http::jwt::Claims {
			inner: serde_json::Map::from_iter([("team".to_string(), json!("research"))]),
			jwt: secrecy::SecretString::new("fake.jwt.token".into()),
		});
		let snapshot = crate::cel::snapshot_request(&mut req, false);
		let rules = rules(json!([{
			"condition": "jwt.team == 'research'",
			"cost": {"input": "0", "output": "0"},
		}]));
		let cost = llm("gpt")
			.with_pricing(Some(&rules), Some(&snapshot))
			.cost
			.unwrap();
		assert_eq!(cost.total(), Decimal::ZERO);
		let cost = llm("gpt").with_pricing(Some(&rules), None).cost.unwrap();
		assert_eq!(cost.total(), dec("6"));
	}

	#[test]
	fn policy_registers_pricing_expressions() {
		let policy: crate::llm::Policy = serde_json::from_value(json!({
			"pricing": [{"condition": "jwt.team == 'a'", "cost": {"input": "0", "cacheWrite1h": "0"}}],
		}))
		.unwrap();
		assert_eq!(policy.expressions().count(), 3);
	}
}
