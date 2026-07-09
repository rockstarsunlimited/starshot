#[cfg(not(target_arch = "wasm32"))]
mod cli {
    use std::env;
    use std::error::Error;
    use std::fs::File;
    use std::path::Path;

    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct UploadResponse {
        url: String,
    }

    fn usage(exit_code: i32) -> ! {
        eprintln!(
            "Usage:
  starshot-cli upload-file <path> [--scope humans|agents]

Environment:
  STARSHOT_UPLOAD_URL  Worker upload endpoint
  AUTH_TOKEN           Worker bearer token
  STARSHOT_AUTH_TOKEN  Alternate bearer token name"
        );
        std::process::exit(exit_code);
    }

    fn arg_value(args: &[String], name: &str, fallback: &str) -> String {
        let prefix = format!("{name}=");
        if let Some(value) = args.iter().find_map(|arg| arg.strip_prefix(&prefix)) {
            return value.to_string();
        }
        if let Some(index) = args.iter().position(|arg| arg == name) {
            if let Some(next) = args.get(index + 1) {
                if !next.starts_with("--") {
                    return next.to_string();
                }
            }
        }
        fallback.to_string()
    }

    fn positional_file(args: &[String]) -> Option<&str> {
        let mut skip_next = false;
        for arg in args {
            if skip_next {
                skip_next = false;
                continue;
            }
            if arg.starts_with("--") {
                if !arg.contains('=') && arg == "--scope" {
                    skip_next = true;
                }
                continue;
            }
            return Some(arg);
        }
        None
    }

    fn content_type(path: &Path) -> Result<&'static str, Box<dyn Error>> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match extension.as_str() {
            "png" => Ok("image/png"),
            "jpg" | "jpeg" => Ok("image/jpeg"),
            "heic" => Ok("image/heic"),
            "heif" => Ok("image/heif"),
            _ => Err(format!("unsupported image type: {}", path.display()).into()),
        }
    }

    fn upload_file(args: &[String]) -> Result<(), Box<dyn Error>> {
        let file_arg = positional_file(args).ok_or("missing file path")?;
        let path = Path::new(file_arg);
        let file = File::open(path)?;
        let upload_url = env::var("STARSHOT_UPLOAD_URL")?;
        let token = env::var("STARSHOT_AUTH_TOKEN").or_else(|_| env::var("AUTH_TOKEN"))?;
        let scope = arg_value(args, "--scope", "agents");
        if scope != "humans" && scope != "agents" {
            return Err("--scope must be humans or agents".into());
        }

        let mut response = ureq::post(&upload_url)
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", content_type(path)?)
            .header("X-Starshot-Scope", &scope)
            .send(ureq::SendBody::from_owned_reader(file))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.body_mut().read_to_string().unwrap_or_default();
            return Err(format!(
                "upload failed: {status} {}",
                body.chars().take(500).collect::<String>()
            )
            .into());
        }

        let result: UploadResponse = response.body_mut().read_json()?;
        if result.url.is_empty() {
            return Err("upload failed: response did not include a URL".into());
        }
        println!("{}", result.url);
        Ok(())
    }

    pub fn main() {
        let args: Vec<String> = env::args().skip(1).collect();
        let Some(command) = args.first().map(String::as_str) else {
            usage(2);
        };
        let command_args = &args[1..];
        let result = match command {
            "upload-file" => upload_file(command_args),
            "help" | "--help" | "-h" => usage(0),
            _ => Err(format!("unknown command: {command}").into()),
        };

        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    cli::main();
}

#[cfg(target_arch = "wasm32")]
fn main() {}
