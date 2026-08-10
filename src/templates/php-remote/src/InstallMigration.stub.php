<?php

declare(strict_types=1);

/**
 * Migration stub — adapt to your framework's migration format. The Flashmandu
 * platform handles the install record; this is for any app-local state you
 * need per install (e.g. caching scopes, mirroring the install_id).
 *
 * Replace the placeholder table name + columns with your schema.
 */

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('flashmandu_installs', function (Blueprint $table): void {
            $table->id();
            $table->string('app_id')->index();
            $table->unsignedBigInteger('install_id')->nullable();
            $table->unsignedBigInteger('profile_id')->nullable();
            $table->json('scopes')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('flashmandu_installs');
    }
};
