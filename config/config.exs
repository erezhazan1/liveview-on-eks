# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :demo,
  ecto_repos: [Demo.Repo]

# Configures the endpoint
# NOTE: `secret_key_base` is deliberately NOT set here.
#
# Upstream shipped a hardcoded one in this file, which applies to EVERY environment -
# so it was compiled into the production release's releases/<vsn>/sys.config and shipped
# inside the image, even though config/runtime.exs overrides it at boot. Phoenix's own
# generator puts dev/test values in config/dev.exs and config/test.exs and reads
# production's from the environment in config/runtime.exs; that layout is restored here,
# so no secret_key_base value of any kind is baked into the production artifact.
config :demo, DemoWeb.Endpoint,
  url: [host: "localhost"],
  render_errors: [view: DemoWeb.ErrorView, accepts: ~w(html json), layout: false],
  pubsub_server: Demo.PubSub,
  # Signing salts are domain separators, not secrets - Phoenix's generator commits them
  # in every app it creates. Regenerated anyway, so this repo republishes no credential
  # material copied from upstream.
  live_view: [signing_salt: "BS4fsrlQ"]

# Configures the mailer
#
# By default it uses the "Local" adapter which stores the emails
# locally. You can see the emails in your browser, at "/dev/mailbox".
#
# For production it's recommended to configure a different adapter
# at the `config/runtime.exs`.
config :demo, Demo.Mailer, adapter: Swoosh.Adapters.Local

# Swoosh API client is needed for adapters other than SMTP.
config :swoosh, :api_client, false

# Configure esbuild (the version is required)
config :esbuild,
  version: "0.12.18",
  default: [
    args: ~w(js/app.js --bundle --target=es2016 --outdir=../priv/static/assets),
    cd: Path.expand("../assets", __DIR__),
    env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}
  ]

# Configures Elixir's Logger
config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
