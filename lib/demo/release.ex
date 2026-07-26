defmodule Demo.Release do
  @moduledoc "Release tasks (no Mix in a release). Run: /app/bin/demo eval 'Demo.Release.migrate()'"
  @app :demo

  def migrate do
    Application.load(@app)

    for repo <- Application.fetch_env!(@app, :ecto_repos) do
      {:ok, _, _} = Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :up, all: true))
    end
  end
end
