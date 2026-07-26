ARG BUILDER_IMAGE="hexpm/elixir:1.14.5-erlang-25.3.2.21-debian-bookworm-20260713-slim"
ARG RUNNER_IMAGE="debian:bookworm-20260713-slim"

FROM ${BUILDER_IMAGE} AS builder

RUN apt-get update -y && apt-get install -y build-essential git ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mix local.hex --force && mix local.rebar --force
ENV MIX_ENV=prod

# Deps first - cache layer survives app-code changes
COPY mix.exs mix.lock ./
RUN mix deps.get --only $MIX_ENV
RUN mkdir config
COPY config/config.exs config/prod.exs config/
RUN mix deps.compile

COPY priv priv
COPY lib lib
COPY assets assets
# esbuild wrapper downloads its pinned binary (0.12.18) here - needs network.
# In GovCloud CI this build runs commercial-side; the image is promoted into GovCloud ECR.
RUN mix assets.deploy
RUN mix compile

# runtime.exs is read at boot, not compile - copy last so config tweaks don't bust caches
COPY config/runtime.exs config/
RUN mix release

FROM ${RUNNER_IMAGE}

# procps: TopLive shells out to `top -bn1` (BusyBox top lacks -b - Alpine would break it)
# wamerican: SearchLive greps /usr/share/dict/words
# dict: SearchLive definitions (needs egress to dict.org - degrades gracefully without it)
RUN apt-get update -y \
    && apt-get install -y libstdc++6 openssl libncurses5 locales ca-certificates procps wamerican dict \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen

ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8 MIX_ENV=prod

WORKDIR /app
COPY --from=builder --chown=nobody:root /app/_build/prod/rel/demo ./
USER nobody

# The release script exec's into the BEAM: the VM is PID 1, traps SIGTERM,
# and runs a clean OTP shutdown (endpoint drainer included). No shell, no tini.
ENTRYPOINT ["/app/bin/demo"]
CMD ["start"]
