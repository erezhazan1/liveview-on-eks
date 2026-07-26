defmodule DemoWeb.HealthPlug do
  @moduledoc """
  Liveness/readiness endpoint. Deliberately does NOT check the database:
  most LiveView demos work without it, and failing readiness on an RDS blip
  would drop every healthy pod's open sockets - worse than degraded pages.
  """
  import Plug.Conn

  def init(opts), do: opts

  def call(%Plug.Conn{request_path: "/healthz"} = conn, _opts) do
    conn |> send_resp(200, "ok") |> halt()
  end

  def call(conn, _opts), do: conn
end
