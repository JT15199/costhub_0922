use serde_json::{json, Value};

/// Keeps UTF-8 bytes until a complete line, and SSE data until a complete event.
#[derive(Default)]
pub struct LocalStreamDecoder {
    buffer: Vec<u8>,
    data: Vec<String>,
    reason: Option<String>,
    pub done: bool,
}

impl LocalStreamDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<(&'static str, String)>, String> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 16 * 1024 * 1024 { return Err("本地模型单条流事件超过 16MB".into()); }
        let mut events = Vec::new();
        while let Some(pos) = self.buffer.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.buffer.drain(..=pos).collect();
            let line = std::str::from_utf8(&raw).map_err(|_| "本地模型流包含无效 UTF-8")?.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() { let data = std::mem::take(&mut self.data).join("\n"); self.decode(&data, &mut events)?; }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data.push(data.strip_prefix(' ').unwrap_or(data).to_string());
            } else if line.starts_with('{') {
                self.decode(line, &mut events)?;
            } else if !line.starts_with(':') && !line.starts_with("event:") && !line.starts_with("id:") && !line.starts_with("retry:") {
                return Err("本地模型返回无法识别的流格式".into());
            }
            if self.done { break; }
        }
        Ok(events)
    }

    fn decode(&mut self, data: &str, events: &mut Vec<(&'static str, String)>) -> Result<(), String> {
        if data.trim() == "[DONE]" {
            self.done = true;
            events.push(("llm-done", String::new()));
            return Ok(());
        }
        let value: Value = serde_json::from_str(data).map_err(|_| "本地模型返回损坏的 JSON 流事件")?;
        if let Some(error) = value.get("error") { return Err(format!("本地模型服务错误：{}", error)); }
        if value.get("choices").is_some() || value.get("usage").is_some() {
            let choice = &value["choices"][0];
            let delta = &choice["delta"];
            for (field, event) in [("content", "llm-token"), ("reasoning_content", "llm-reasoning")] {
                let item = delta.get(field).or_else(|| if field == "reasoning_content" { delta.get("reasoning") } else { None });
                if let Some(text) = item.and_then(Value::as_str).filter(|s| !s.is_empty()) { events.push((event, text.to_string())); }
            }
            if let Some(calls) = delta.get("tool_calls").filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false)) {
                events.push(("llm-toolcall-delta", calls.to_string()));
            }
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.reason = Some(reason.to_string());
                events.push(("llm-meta", json!({"doneReason": reason}).to_string()));
                if reason == "length" { events.push(("llm-truncated", String::new())); }
            }
            if let Some(usage) = value.get("usage").filter(|v| v.is_object()) {
                events.push(("llm-meta", json!({"promptEvalCount": usage["prompt_tokens"], "evalCount": usage["completion_tokens"], "doneReason": self.reason}).to_string()));
            }
        } else if let Some(message) = value.get("message") {
            for (field, event) in [("content", "llm-token"), ("thinking", "llm-reasoning")] {
                if let Some(text) = message.get(field).and_then(Value::as_str).filter(|s| !s.is_empty()) { events.push((event, text.to_string())); }
            }
            if let Some(calls) = message.get("tool_calls").filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false)) { events.push(("llm-toolcalls", calls.to_string())); }
            if value["done"].as_bool() == Some(true) {
                self.reason = value.get("done_reason").or_else(|| value.get("finish_reason")).and_then(Value::as_str).map(str::to_string);
                if self.reason.as_deref() == Some("length") { events.push(("llm-truncated", String::new())); }
                events.push(("llm-meta", json!({"promptEvalCount": value["prompt_eval_count"], "evalCount": value["eval_count"], "totalDurationNs": value["total_duration"], "loadDurationNs": value["load_duration"], "promptEvalDurationNs": value["prompt_eval_duration"], "evalDurationNs": value["eval_duration"], "doneReason": self.reason}).to_string()));
                self.done = true;
                events.push(("llm-done", String::new()));
            }
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<Vec<(&'static str, String)>, String> {
        let mut events = self.push(b"\n\n")?;
        if !self.done {
            if self.reason.is_none() { return Err("本地模型连接中断，未收到结束标记；未执行未完成的工具调用".into()); }
            self.done = true;
            events.push(("llm-done", String::new()));
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_utf8_tool_arguments_usage_and_disconnect() {
        let source = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\\\"报价.csv\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":50}}\n\n",
            "data: [DONE]\n\n");
        let mut decoder = LocalStreamDecoder::default();
        let mut events = Vec::new();
        for byte in source.as_bytes() { events.extend(decoder.push(&[*byte]).unwrap()); }
        assert!(events.iter().any(|(event, body)| *event == "llm-toolcall-delta" && body.contains("报价.csv")));
        assert!(events.iter().any(|(event, body)| *event == "llm-meta" && body.contains("100") && body.contains("length")));
        assert_eq!(events.iter().filter(|(event, _)| *event == "llm-done").count(), 1);
        let mut broken = LocalStreamDecoder::default();
        broken.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n").unwrap();
        assert!(broken.finish().is_err());
        assert!(LocalStreamDecoder::default().push(b"data: broken\n\n").is_err());
        let mut ollama = LocalStreamDecoder::default();
        let events = ollama.push(b"{\"message\":{\"content\":\"ok\"},\"done\":true,\"eval_count\":3}\n").unwrap();
        assert!(ollama.done);
        assert!(events.iter().any(|(event, _)| *event == "llm-token"));
    }
}
