//! WebView 无 SubtleCrypto 时的语音签名兜底；不访问文件、网络，不记录输入。
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

#[tauri::command]
pub fn speech_digest(data: Vec<u8>, key: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    if data.len() > 1024 * 1024 || key.as_ref().is_some_and(|value| value.len() > 4096) {
        return Err("签名数据超过大小限制".into());
    }
    match key {
        Some(key) => {
            let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| "签名密钥无效")?;
            mac.update(&data);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        None => Ok(Sha256::digest(&data).to_vec()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_rfc_4231() {
        let result = super::speech_digest(b"Hi There".to_vec(), Some(vec![0x0b; 20])).unwrap();
        assert_eq!(hex::encode(result), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
        assert_eq!(hex::encode(super::speech_digest(b"abc".to_vec(), None).unwrap()), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
